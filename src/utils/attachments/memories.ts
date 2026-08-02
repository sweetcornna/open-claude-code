import type { ToolUseContext } from '../../Tool.js'
import type { Message } from 'src/types/message.js'
import type { AgentDefinition } from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { FILE_READ_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/FileReadTool/prompt.js'
import type { FileStateCache } from '../fileStateCache.js'
import { createChildAbortController } from '../process/abortController.js'
import { findRelevantMemories } from '../../memdir/findRelevantMemories.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { getAgentMemoryDir } from '@open-claude-code/builtin-tools/tools/AgentTool/agentMemory.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getUserMessageText } from '../messages.js'
import { isAbortError } from '../runtime/errors.js'
import { logError } from '../telemetry/log.js'
import { logEvent } from 'src/services/analytics/index.js'
import { memoryAge, memoryFreshnessText } from '../../memdir/memoryAge.js'
import { readFileInRange } from '../filesystem/readFileInRange.js'
import {
  MAX_MEMORY_BYTES,
  MAX_MEMORY_LINES,
  RELEVANT_MEMORIES_CONFIG,
} from './config.js'
import type { Attachment } from './types.js'
import { extractAgentMentions } from './mentions.js'
import { collectRecentSuccessfulTools } from './history.js'

export async function getRelevantMemoryAttachments(
  input: string,
  agents: AgentDefinition[],
  readFileState: FileStateCache,
  recentTools: readonly string[],
  signal: AbortSignal,
  alreadySurfaced: ReadonlySet<string>,
  parentSpan?: unknown,
): Promise<Attachment[]> {
  // If an agent is @-mentioned, search only its memory dir (isolation).
  // Otherwise search the auto-memory dir.
  const memoryDirs = extractAgentMentions(input).flatMap(mention => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find(def => def.agentType === agentType)
    return agentDef?.memory
      ? [getAgentMemoryDir(agentType, agentDef.memory)]
      : []
  })
  const dirs = memoryDirs.length > 0 ? memoryDirs : [getAutoMemPath()]

  const allResults = await Promise.all(
    dirs.map(dir =>
      findRelevantMemories(
        input,
        dir,
        signal,
        recentTools,
        alreadySurfaced,
        parentSpan as Parameters<typeof findRelevantMemories>[5],
      ).catch(() => []),
    ),
  )
  // alreadySurfaced is filtered inside the selector so Sonnet spends its
  // 5-slot budget on fresh candidates; readFileState catches files the
  // model read via FileReadTool. The redundant alreadySurfaced check here
  // is a belt-and-suspenders guard (multi-dir results may re-introduce a
  // path the selector filtered in a different dir).
  const selected = allResults
    .flat()
    .filter(m => !readFileState.has(m.path) && !alreadySurfaced.has(m.path))
    .slice(0, 5)

  const memories = await readMemoriesForSurfacing(selected, signal)

  if (memories.length === 0) {
    return []
  }
  return [{ type: 'relevant_memories' as const, memories }]
}

/**
 * Scan messages for past relevant_memories attachments.  Returns both the
 * set of surfaced paths (for selector de-dup) and cumulative byte count
 * (for session-total throttle).  Scanning messages rather than tracking
 * in toolUseContext means compact naturally resets both — old attachments
 * are gone from the compacted transcript, so re-surfacing is valid again.
 */
export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
  paths: Set<string>
  totalBytes: number
} {
  const paths = new Set<string>()
  let totalBytes = 0
  for (const m of messages) {
    if (m.type === 'attachment' && m.attachment!.type === 'relevant_memories') {
      for (const mem of m.attachment!.memories as {
        path: string
        content: string
        mtimeMs: number
      }[]) {
        paths.add(mem.path)
        totalBytes += mem.content.length
      }
    }
  }
  return { paths, totalBytes }
}

/**
 * Reads a set of relevance-ranked memory files for injection as
 * <system-reminder> attachments. Enforces both MAX_MEMORY_LINES and
 * MAX_MEMORY_BYTES via readFileInRange's truncateOnByteLimit option.
 * Truncation surfaces partial
 * content with a note rather than dropping the file — findRelevantMemories
 * already picked this as most-relevant, so the frontmatter + opening context
 * is worth surfacing even if later lines are cut.
 *
 * Exported for direct testing without mocking the ranker + GB gates.
 */
export async function readMemoriesForSurfacing(
  selected: ReadonlyArray<{ path: string; mtimeMs: number }>,
  signal?: AbortSignal,
): Promise<
  Array<{
    path: string
    content: string
    mtimeMs: number
    header: string
    limit?: number
  }>
> {
  const results = await Promise.all(
    selected.map(async ({ path: filePath, mtimeMs }) => {
      try {
        const result = await readFileInRange(
          filePath,
          0,
          MAX_MEMORY_LINES,
          MAX_MEMORY_BYTES,
          signal,
          { truncateOnByteLimit: true },
        )
        const truncated =
          result.totalLines > MAX_MEMORY_LINES || result.truncatedByBytes
        const content = truncated
          ? result.content +
            `\n\n> This memory file was truncated (${result.truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Use the ${FILE_READ_TOOL_NAME} tool to view the complete file at: ${filePath}`
          : result.content
        return {
          path: filePath,
          content,
          mtimeMs,
          header: memoryHeader(filePath, mtimeMs),
          limit: truncated ? result.lineCount : undefined,
        }
      } catch {
        return null
      }
    }),
  )
  return results.filter(r => r !== null)
}

/**
 * Header string for a relevant-memory block.  Exported so messages.ts
 * can fall back for resumed sessions where the stored header is missing.
 */
export function memoryHeader(path: string, mtimeMs: number): string {
  const staleness = memoryFreshnessText(mtimeMs)
  return staleness
    ? `${staleness}\n\nMemory: ${path}:`
    : `Memory (saved ${memoryAge(mtimeMs)}): ${path}:`
}

/**
 * A memory relevance-selector prefetch handle. The promise is started once
 * per user turn and runs while the main model streams and tools execute.
 * At the collect point (post-tools), the caller reads settledAt to
 * consume-if-ready or skip-and-retry-next-iteration — the prefetch never
 * blocks the turn.
 *
 * Disposable: query.ts binds with `using`, so [Symbol.dispose] fires on all
 * generator exit paths (return, throw, .return() closure) — aborting the
 * in-flight request and emitting terminal telemetry without instrumenting
 * each of the ~13 return sites inside the while loop.
 */
export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  /** Set by promise.finally(). null until the promise settles. */
  settledAt: number | null
  /** Set by the collect point in query.ts. -1 until consumed. */
  consumedOnIteration: number
  [Symbol.dispose](): void
}

/**
 * Starts the relevant memory search as an async prefetch.
 * Extracts the last real user prompt from messages (skipping isMeta system
 * injections) and kicks off a non-blocking search. Returns a Disposable
 * handle with settlement tracking. Bound with `using` in query.ts.
 */
export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
): MemoryPrefetch | undefined {
  if (
    !isAutoMemoryEnabled() ||
    !getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)
  ) {
    return undefined
  }

  // Poor mode: skip the side-query to save tokens
  const { isPoorModeActive } =
    require('../../commands/poor/poorMode.js') as typeof import('../../commands/poor/poorMode.js')
  if (isPoorModeActive()) {
    return undefined
  }

  const lastUserMessage = messages.findLast(m => m.type === 'user' && !m.isMeta)
  if (!lastUserMessage) {
    return undefined
  }

  const input = getUserMessageText(lastUserMessage)
  // Single-word prompts lack enough context for meaningful term extraction
  if (!input || !/\s/.test(input.trim())) {
    return undefined
  }

  const surfaced = collectSurfacedMemories(messages)
  if (surfaced.totalBytes >= RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES) {
    return undefined
  }

  // Chained to the turn-level abort so user Escape cancels the sideQuery
  // immediately, not just on [Symbol.dispose] when queryLoop exits.
  const controller = createChildAbortController(toolUseContext.abortController)
  const firedAt = Date.now()
  const promise = getRelevantMemoryAttachments(
    input,
    toolUseContext.options.agentDefinitions.activeAgents,
    toolUseContext.readFileState,
    collectRecentSuccessfulTools(messages, lastUserMessage),
    controller.signal,
    surfaced.paths,
    toolUseContext.langfuseTrace,
  ).catch(e => {
    if (!isAbortError(e)) {
      logError(e)
    }
    return []
  })

  const handle: MemoryPrefetch = {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
    [Symbol.dispose]() {
      controller.abort()
      logEvent('tengu_memdir_prefetch_collected', {
        hidden_by_first_iteration:
          handle.settledAt !== null && handle.consumedOnIteration === 0,
        consumed_on_iteration: handle.consumedOnIteration,
        latency_ms: (handle.settledAt ?? Date.now()) - firedAt,
      })
    },
  }
  void promise.finally(() => {
    handle.settledAt = Date.now()
  })
  return handle
}

/**
 * Filters prefetched memory attachments to exclude memories the model already
 * has in context via FileRead/Write/Edit tool calls (any iteration this turn)
 * or a previous turn's memory surfacing — both tracked in the cumulative
 * readFileState. Survivors are then marked in readFileState so subsequent
 * turns won't re-surface them.
 *
 * The mark-after-filter ordering is load-bearing: readMemoriesForSurfacing
 * used to write to readFileState during the prefetch, which meant the filter
 * saw every prefetch-selected path as "already in context" and dropped them
 * all (self-referential filter). Deferring the write to here, after the
 * filter runs, breaks that cycle while still deduping against tool calls
 * from any iteration.
 */
export function filterDuplicateMemoryAttachments(
  attachments: Attachment[],
  readFileState: FileStateCache,
): Attachment[] {
  return attachments
    .map(attachment => {
      if (attachment.type !== 'relevant_memories') return attachment
      const filtered = attachment.memories.filter(
        m => !readFileState.has(m.path),
      )
      for (const m of filtered) {
        readFileState.set(m.path, {
          content: m.content,
          timestamp: m.mtimeMs,
          offset: undefined,
          limit: m.limit,
        })
      }
      return filtered.length > 0 ? { ...attachment, memories: filtered } : null
    })
    .filter((a): a is Attachment => a !== null)
}
