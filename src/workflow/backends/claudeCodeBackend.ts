// Deeply-integrated backend: parses agent/model/tools from the live session, delegates to the core runAgent.
// Implements the AgentAdapter interface, registered and routed by the registry (U5).
import {
  type AgentAdapter,
  type AgentAdapterContext,
  type AgentRunParams,
  type AgentRunResult,
  WorkflowAbortedError,
} from '@open-claude-code/workflow-engine'
import { assembleToolPool } from '../../tools.js'
import { finalizeAgentTool } from '@open-claude-code/builtin-tools/tools/AgentTool/agentToolUtils.js'
import { isAgentExecutionLimitError } from '@open-claude-code/builtin-tools/tools/AgentTool/agentExecutionWatchdog.js'
import { runAgent } from '@open-claude-code/builtin-tools/tools/AgentTool/runAgent.js'
import {
  isBuiltInAgent,
  type AgentDefinition,
  type BuiltInAgentDefinition,
} from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { createUserMessage, extractTextContent } from '../../utils/messages.js'
import { getTokenCountFromUsage } from '../../utils/session/tokens.js'
import { createHash } from 'node:crypto'
import { createAgentId } from '../../utils/collections/uuid.js'
import { logForDebugging } from '../../utils/telemetry/debug.js'
import { runWithCwdOverride } from '../../utils/filesystem/cwd.js'
import {
  createAgentWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
} from '../../utils/git/worktree.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from '@ant/model-provider'
import { logEvent } from '../../services/analytics/index.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { readHostBundle } from '../hostHandle.js'

/** Fallback definition for workflow subagents (used when agentType does not match a real registry entry). */
export const WORKFLOW_AGENT: BuiltInAgentDefinition = {
  agentType: 'workflow-worker',
  whenToUse: 'subtask dispatched by the agent() hook inside a workflow script',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () =>
    'You are a workflow sub-agent. Complete the task concisely; your final text is the return value relayed to the workflow.',
}

/** agentType -> real agent registry (use if activeAgents hits, otherwise fallback). Exported for unit test coverage. */
export function resolveAgentDefinition(
  agentType: string | undefined,
  toolUseContext: ToolUseContext,
): AgentDefinition {
  if (!agentType) return WORKFLOW_AGENT
  const found = toolUseContext.options.agentDefinitions.activeAgents.find(
    a => a.agentType === agentType,
  )
  return found ?? WORKFLOW_AGENT
}

/** model alias -> the actual model id of the current provider. v1 passes it through directly (keeps a mapping extension point). Exported for unit test coverage. */
export function mapWorkflowModel(
  model: string | undefined,
): string | undefined {
  return model
}

/**
 * A brace-balanced `{...}` candidate that JSON.parse rejected.
 *
 * Kept so the schema-mode failure path can say *why* the answer was discarded. Without it the
 * dead-reason preview is just the first 200 chars of the agent's text, which for a malformed answer
 * is the opening of a JSON object and therefore looks perfectly healthy — the failure reads as
 * "the agent never emitted JSON" when in fact it emitted almost-valid JSON.
 */
export type MalformedJsonCandidate = {
  /** Where the candidate starts in the text block (the fence, for a fenced candidate). */
  offset: number
  /** JSON.parse's message, verbatim. */
  error: string
  /** Text around the offending token, or the candidate's head when the engine reports no position. */
  excerpt: string
}

/** Result of scanning one agent answer for its schema-mode JSON object. */
export type StructuredOutputScan = {
  /** The extracted plain object, or null when nothing usable was found. */
  value: unknown | null
  /** First balanced-but-unparseable candidate seen, when no object could be extracted. */
  malformed?: MalformedJsonCandidate
}

/**
 * Extract the JSON object produced under schema mode from the agent's final message; returns null on failure. Exported for unit test coverage.
 *
 * Robustness strategy (in priority order, returns the first that successfully parses):
 * 1. fenced code block (```json ... ``` or ``` ... ```) - agents often spontaneously add fences
 * 2. the first "brace-balanced" {...} fragment in the bare text - handles preceding/trailing narration / multi-segment output
 *
 * Uses a brace-stack scan instead of `indexOf('{')..lastIndexOf('}')`: correctly handles nested objects,
 * `{}` inside string literals, and escape characters. Will not concatenate multiple unrelated JSON fragments (the original version did).
 *
 * Does not do syntax repair (trailing commas, single quotes -> double quotes, comment removal) - agents do not produce non-standard JSON,
 * and fixing it may instead cause wrong edits inside strings (e.g. `"http://..."` getting eaten by a // comment regex).
 * On parse failure it directly skips to the next candidate.
 *
 * Only returns a plain object (typeof === 'object' && !null && !Array);
 * the schema mode contract is object, array/number/string are all treated as the agent going off-track.
 */
export function extractStructuredOutput(
  content: Array<{ type: string; text?: string }>,
): unknown | null {
  return scanStructuredOutput(content).value
}

/** As extractStructuredOutput, but also reports why extraction failed. Exported for unit test coverage. */
export function scanStructuredOutput(
  content: Array<{ type: string; text?: string }>,
): StructuredOutputScan {
  let malformed: MalformedJsonCandidate | undefined
  for (const block of content) {
    if (block.type !== 'text' || !block.text) continue
    const found = findFirstJsonObject(block.text)
    if (found.value !== null) return found
    malformed ??= found.malformed
  }
  return malformed ? { value: null, malformed } : { value: null }
}

/**
 * Find the first JSON fragment in text that can be parsed as a plain object.
 *
 * A candidate that balances but fails to parse is skipped **whole** (`i = end`), never descended
 * into. This is the difference between an honest failure and silent data corruption: every `{`
 * inside a rejected object is one of its own nested values, so resuming the scan at `i + 1` walks
 * into the wreck and returns a *fragment of the agent's answer* as if it were the answer.
 *
 * That is not hypothetical. A research agent emitted `{"market":…,"fields":{…},"search_audit":{…}}`
 * containing an unescaped `"` inside a prose string; JSON.parse rejected the whole object, the scan
 * descended, and the *value of `fields`* came back as a fully-formed `kind:'ok'` result. The audit
 * fields the workflow relied on were simply gone — no error, no retry, wrong data downstream.
 * Returning null instead lets the engine retry the run (AGENT_MAX_RETRIES_BY_REASON).
 *
 * An *unbalanced* `{` still falls through to `i + 1`: it is normally prose noise ("use { like this")
 * rather than a truncated object, and skipping the rest of the text on account of it would throw
 * away answers that parse fine.
 */
function findFirstJsonObject(text: string): StructuredOutputScan {
  let malformed: MalformedJsonCandidate | undefined
  // 1. fenced code blocks - priority (agents naturally tend to add them; strip the fence and parse the whole block)
  for (const m of text.matchAll(
    /```[\t ]*[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```/g,
  )) {
    const candidate = m[1] ?? ''
    const parsed = tryParseObject(candidate)
    if (parsed.value !== null) return { value: parsed.value }
    malformed ??= describeMalformed(candidate, m.index ?? 0, parsed.error)
  }
  // 2. bare text: scan each '{', find a balanced pair and try parse
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    const end = findBalancedObjectEnd(text, i)
    if (end < 0) continue
    const candidate = text.slice(i, end + 1)
    const parsed = tryParseObject(candidate)
    if (parsed.value !== null) return { value: parsed.value }
    malformed ??= describeMalformed(candidate, i, parsed.error)
    i = end // skip the failed candidate whole — see the doc comment above
  }
  return malformed ? { value: null, malformed } : { value: null }
}

/**
 * Build the diagnostic for a rejected candidate, centred on the token JSON.parse choked on.
 *
 * The two engines report differently and neither leaves the reader stranded:
 * V8 (the `occ` bin runs on node) says `... in JSON at position 179`, which centres the excerpt on
 * the real syntax error; JSC (`bun run dev`) omits the position but names the token instead
 * (`Unrecognized token '扩'`), so `error` carries the signal and the excerpt falls back to the head.
 */
export function describeMalformed(
  candidate: string,
  offset: number,
  error: string | undefined,
): MalformedJsonCandidate | undefined {
  if (error === undefined) return undefined // not JSON-shaped at all; not worth reporting
  const at = /at position (\d+)/.exec(error)
  const pos = at?.[1] ? Number(at[1]) : 0
  return {
    offset,
    error,
    excerpt: candidate.slice(Math.max(0, pos - 60), pos + 60),
  }
}

/**
 * Find the matching `}` index starting from start (which must be `{`); returns -1 when unbalanced.
 * Skips braces inside string literals and escape characters. Does not skip comments (the JSON standard does not allow comments,
 * agents do not produce them; doing so is a risk - see the function doc).
 */
function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\')
        i++ // skip the escape char and the next character
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * try parse the candidate; only returns a plain object, others (array/number/null) return null.
 *
 * `error` is set only for a JSON-shaped candidate that JSON.parse rejected — that is the case worth
 * reporting back to the user. A candidate that is not brace-delimited at all is ordinary prose and
 * leaves `error` unset.
 */
function tryParseObject(candidate: string): {
  value: unknown | null
  error?: string
} {
  const trimmed = candidate.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return { value: null }
  try {
    const v = JSON.parse(trimmed)
    return {
      value:
        typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null,
    }
  } catch (e) {
    return { value: null, error: (e as Error).message }
  }
}

/**
 * git's index/ref lock signatures. Matched against the worktree-creation error text to tell a
 * transient collision (another agent holds the lock right now) apart from the deterministic
 * environment failures that share reason:'worktree-failed'.
 *
 * Matching on message text is unavoidable: git reports every one of these as exit code 128 with
 * no distinguishing code, and the three alternatives cover what git actually prints —
 * `Unable to create '<path>/index.lock': File exists`, `cannot lock ref 'refs/...'`, and the
 * `Unable to create ... .lock` form used by ref updates. Exported for direct unit coverage;
 * a false positive here costs one extra backoff, a false negative costs a lost agent.
 */
export function isGitLockContention(detail: string): boolean {
  return /\.lock': File exists|cannot lock ref|Unable to create .*\.lock/i.test(
    detail,
  )
}

type WorkflowWorktreeInfo = Awaited<ReturnType<typeof createAgentWorktree>>

/**
 * Generate a slug for the worktree isolation of a workflow agent: derive hex segments from sha256(runId:agentId),
 * matching the cleanup regex of cleanupStaleAgentWorktrees `^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$`.
 * taskId is `w`+base36 (not a UUID), so runId cannot be placed directly into the regex segment; sha256 is a deterministic mapping,
 * and agentId ensures slug uniqueness for multiple agents under the same runId (no shared counter, no thread safety issues).
 */
function makeWorkflowWorktreeSlug(runId: string, agentId: string): string {
  const h = createHash('sha256').update(`${runId}:${agentId}`).digest('hex')
  return `wf_${h.slice(0, 8)}-${h.slice(8, 11)}-${parseInt(h.slice(11, 17), 16) % 100000}`
}

/**
 * Clean up the worktree after the agent finishes: hookBased keeps it (cannot detect VCS changes); otherwise uses
 * hasWorktreeChanges (fail-closed) to detect, auto-removes when there is no change, keeps it on change/detection failure
 * and logs the path (v1 uses logs rather than extending AgentRunResult, to avoid touching journal serialization).
 */
async function cleanupWorkflowWorktree(
  info: WorkflowWorktreeInfo,
  agentType: string,
): Promise<void> {
  if (info.hookBased || !info.headCommit) return
  let changed = true
  try {
    changed = await hasWorktreeChanges(info.worktreePath, info.headCommit)
  } catch (e) {
    logForDebugging(
      `workflow worktree change-detect failed (${agentType}): ${(e as Error).message}`,
    )
    changed = true
  }
  if (!changed) {
    try {
      await removeAgentWorktree(
        info.worktreePath,
        info.worktreeBranch,
        info.gitRoot,
      )
    } catch (e) {
      logForDebugging(
        `workflow worktree remove failed (${agentType}): ${(e as Error).message}`,
      )
    }
  } else {
    logForDebugging(
      `workflow worktree retained (has changes, ${agentType}): ${info.worktreePath}`,
    )
  }
}

/** Deeply-integrated backend: parses agent/model/tools from the live session, delegates to the core runAgent. */
export const claudeCodeBackend: AgentAdapter = {
  id: 'claude-code',
  capabilities: { structuredOutput: true, tools: true },

  async run(
    params: AgentRunParams,
    ctx: AgentAdapterContext,
  ): Promise<AgentRunResult> {
    const startTime = Date.now()
    const { toolUseContext, canUseTool } = readHostBundle(ctx.host)
    const appState = toolUseContext.getAppState()
    const agentDef = resolveAgentDefinition(params.agentType, toolUseContext)
    const model = mapWorkflowModel(params.model)
    // coreAgentId: the tracking ID for the core-layer subagent (a string, used inside runAgent).
    // Different from ctx.agentId (the engine's number seq, used for panel / killAgent routing) - two distinct concepts, must not be mixed up.
    const coreAgentId = createAgentId()

    const agentAbort = new AbortController()
    const onParentAbort = (): void => agentAbort.abort()
    if (ctx.signal.aborted) {
      agentAbort.abort()
    } else {
      ctx.signal.addEventListener('abort', onParentAbort, { once: true })
    }
    if (typeof ctx.registerAgentAbort === 'function') {
      ctx.registerAgentAbort(ctx.agentId, agentAbort)
    }
    const cleanupAbortBridge = (): void => {
      if (typeof ctx.unregisterAgentAbort === 'function') {
        ctx.unregisterAgentAbort(ctx.agentId)
      }
      ctx.signal.removeEventListener('abort', onParentAbort)
    }

    // isolation:'worktree' - run the agent inside an independent git worktree, so concurrent writes do not conflict.
    let worktreeInfo: WorkflowWorktreeInfo | null = null
    if (params.isolation === 'worktree') {
      try {
        worktreeInfo = await createAgentWorktree(
          makeWorkflowWorktreeSlug(ctx.runId, coreAgentId),
        )
      } catch (e) {
        cleanupAbortBridge()
        if (ctx.signal.aborted) throw new WorkflowAbortedError()
        if (agentAbort.signal.aborted) {
          return {
            kind: 'dead',
            reason: 'agent-cancelled',
            retryable: false,
          }
        }

        // fail-closed: when isolation fails, do not silently fall back to a shared cwd (otherwise concurrent writes race on data)
        const detail = (e as Error).message
        logForDebugging(
          `workflow worktree creation failed (${agentDef.agentType}): ${detail}`,
        )
        // Mostly retryable:false — the causes are environmental and deterministic for an
        // identical call (not a git repo, detached HEAD, no disk, branch name taken).
        // Retrying re-runs git plumbing that failed for a reason that has not changed,
        // and the agent has not even started, so a retry chain is pure latency before the
        // null the script is going to see anyway.
        //
        // The exception is git's own lock contention, which is the one genuinely transient
        // failure here: several agents entering isolation at once race to fetch/create the
        // same ref (worktree.ts's fetch + rev-parse path) with no mutex anywhere in between,
        // and the loser dies on `.lock': File exists`. Raising the default concurrency made
        // that collision more likely, not less, so this must stay retryable — one backoff is
        // normally enough for the holder to release, hence the budget of 1 in
        // AGENT_MAX_RETRIES_BY_REASON rather than the generic three.
        return {
          kind: 'dead',
          reason: 'worktree-failed',
          detail,
          ...(isGitLockContention(detail) ? {} : { retryable: false }),
        }
      }
    }

    if (worktreeInfo && agentAbort.signal.aborted) {
      cleanupAbortBridge()
      if (worktreeInfo) {
        const info = worktreeInfo
        worktreeInfo = null
        await cleanupWorkflowWorktree(info, agentDef.agentType)
      }
      if (ctx.signal.aborted) throw new WorkflowAbortedError()
      return {
        kind: 'dead',
        reason: 'agent-cancelled',
        retryable: false,
      }
    }

    // runWithCwdOverride makes tools such as Bash/Read inside the agent see the worktree path
    // (AsyncLocalStorage is preserved across awaits); the worktreePath parameter of runAgent only writes metadata.
    const runInCwd = worktreeInfo
      ? <T>(fn: () => T): T =>
          runWithCwdOverride(worktreeInfo!.worktreePath, fn)
      : <T>(fn: () => T): T => fn()

    const workerPermissionContext = {
      ...appState.toolPermissionContext,
      mode: agentDef.permissionMode ?? 'acceptEdits',
    }
    const workerTools = assembleToolPool(
      workerPermissionContext,
      appState.mcp.tools,
    )

    // schema -> instructs the agent to directly emit JSON in the final text block.
    // Does not require calling the StructuredOutput tool - it is not in the workflow subagent's tool set (only
    // the stop_hook path explicitly injects it; workflow goes through assembleToolPool whose default pool does not include it).
    // Historically the prompt required "call StructuredOutput tool", causing 8/12 agents to refuse to wrap up or struggle to call it;
    // empirically the main cause of dead is the tool being unreachable rather than "forgetting". Change the contract: raw JSON text, extractStructuredOutput
    // tolerates fenced fences + preceding/trailing narration + multiple segments.
    const promptText = params.schema
      ? [
          params.prompt,
          '',
          'After completing the task, emit your final answer as a single JSON object matching this JSON Schema:',
          '```json',
          JSON.stringify(params.schema, null, 2),
          '```',
          '',
          'CRITICAL RULES:',
          '- The JSON object must be the LAST text block in your response. Do not write any prose after it.',
          '- Emit the JSON as plain text (markdown code fences optional).',
          // Observed failure mode, not a hypothetical: agents writing prose-heavy string values
          // (especially CJK, where the typographic quotes “ ” sit next to ASCII ones on the keyboard)
          // drop a bare `"` mid-sentence. That invalidates the entire object, and the whole run is
          // discarded and retried — so it is worth one line of prompt to prevent.
          '- The JSON must be STRICTLY valid: inside string values, escape every double quote as \\" and every newline as \\n. One unescaped quote invalidates the whole answer and your work is discarded.',
          '- Do NOT call any "StructuredOutput" or "SyntheticOutput" tool — it is not available in this environment.',
          '- Your turn must end with the JSON object. Anything after it (prose, tool calls) will be ignored or cause your answer to be discarded.',
        ].join('\n')
      : params.prompt

    const promptMessages = [createUserMessage({ content: promptText })]
    const messages: Message[] = []
    // Accumulate running progress (onProgress push -> agent_progress event -> panel refreshes token/tool in real time).
    let tokenCount = 0
    let toolCount = 0

    try {
      await runInCwd(async () => {
        for await (const msg of runAgent({
          agentDefinition: agentDef,
          promptMessages,
          toolUseContext,
          canUseTool,
          isAsync: true,
          querySource: toolUseContext.options.querySource ?? 'workflow',
          availableTools: workerTools,
          // override the same object: coreAgentId (core subagent tracking) + abortController (kill bridge).
          // runAgent's model is the top-level ModelAlias; workflow's model is an arbitrary alias string,
          // the types are incompatible and resolved by the provider layer at runtime. Passes through via double assertion (better than as any/never).
          override: { agentId: coreAgentId, abortController: agentAbort },
          ...(model ? { model: model as unknown as ModelAlias } : {}),
          ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
          executionStartedAt: startTime,
        })) {
          messages.push(msg as Message)
          // Accumulate running progress: assistant message carries usage (cumulative value -> overwrite), tool_use inside content (incremental).
          if (msg.type === 'assistant' && msg.message) {
            const usage = msg.message.usage as
              | Parameters<typeof getTokenCountFromUsage>[0]
              | undefined
            if (usage) tokenCount = getTokenCountFromUsage(usage)
            const content = msg.message.content as
              | Array<{ type: string }>
              | undefined
            if (content)
              toolCount += content.filter(b => b.type === 'tool_use').length
          }
          ctx.onProgress?.({ tokenCount, toolCount })
        }
      })
    } catch (e) {
      if (isAgentExecutionLimitError(e)) {
        const reason =
          e.kind === 'total-timeout'
            ? 'agent-total-timeout'
            : 'agent-no-progress'
        logForDebugging(
          `workflow sub-agent execution limit (${agentDef.agentType}): ${e.message}`,
        )
        logEvent('tengu_workflow_agent', { ok: 0 })
        // retryable:false here is a *budget* verdict, not a claim that the call
        // is deterministic — a timeout might well pass on a second run. The
        // engine's retry is an in-place re-invocation of this very function,
        // which re-captures startTime, so every attempt gets a full fresh
        // watchdog budget: flipping this to true turns one limit into up to
        // four consecutive ones (AGENT_MAX_RETRIES = 3), multiplying exactly
        // the wall clock the limit exists to bound — and, when the user set
        // CLAUDE_CODE_AGENT_TOTAL_TIMEOUT_MS explicitly, overrunning a bound
        // they stated on purpose. The panel says "timed out, not retried"
        // rather than "deterministic" (AgentDetail's
        // NON_DETERMINISTIC_FAILURE_REASONS) so the copy stays honest.
        return { kind: 'dead', reason, detail: e.message, retryable: false }
      }
      // Parent cancellation owns the whole run. Check it first because the
      // parent bridge also aborts agentAbort, while a direct agentAbort only
      // cancels this child and must degrade to null without a retry.
      if (ctx.signal.aborted) throw new WorkflowAbortedError()
      if (agentAbort.signal.aborted) {
        return {
          kind: 'dead',
          reason: 'agent-cancelled',
          retryable: false,
        }
      }
      const detail = (e as Error).message
      logForDebugging(
        `workflow sub-agent error (${agentDef.agentType}): ${detail}`,
      )
      logEvent('tengu_workflow_agent', { ok: 0 })
      return { kind: 'dead', reason: 'runagent-threw', detail }
    } finally {
      cleanupAbortBridge()
      if (worktreeInfo) {
        const info = worktreeInfo
        worktreeInfo = null
        await cleanupWorkflowWorktree(info, agentDef.agentType)
      }
    }

    // query() surfaces terminal API errors as an ordinary assistant message
    // (isApiErrorMessage) and ends the generator instead of throwing — so the
    // catch above never sees them. Without this check the error text would
    // masquerade as the agent's answer in non-schema mode ("Prompt is too long"
    // becomes the return value) and get misclassified as no-structured-output in
    // schema mode, triggering doomed identical retries. Context overflow is
    // deterministic for the identical call (retryable:false); anything else
    // (overload / stream drop / timeout) is transient — worth the engine's
    // backed-off retries (AGENT_MAX_RETRIES, on top of whatever the API transport
    // already retried before surfacing this as a terminal error).
    //
    // Reason granularity is the engine's retry budget knob: AGENT_MAX_RETRIES_BY_REASON
    // keys off exactly these strings, so splitting a reason here changes how many times
    // that failure is re-run. 'api-error' stays one bucket deliberately — the terminal
    // message text is not a reliable discriminator between overload and a stream drop,
    // and both want the same treatment.
    let lastAssistant: AssistantMessage | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.type === 'assistant') {
        lastAssistant = messages[i] as AssistantMessage
        break
      }
    }
    if (lastAssistant?.isApiErrorMessage) {
      const rawContent = lastAssistant.message.content
      const errTexts =
        typeof rawContent === 'string'
          ? [rawContent]
          : Array.isArray(rawContent)
            ? (rawContent as Array<{ type: string; text?: string }>)
                .filter(b => b.type === 'text' && typeof b.text === 'string')
                .map(b => b.text as string)
            : []
      const detail = (errTexts.join('\n') || 'API error').slice(0, 300)
      // Same check as errors.ts isPromptTooLongMessage, done locally: importing
      // errors.ts would drag the auth/model/bootstrap chain into this leaf-ish
      // backend (and into every test that mocks around it). The constant lives
      // in @ant/model-provider precisely for consumers like this.
      const promptTooLong = errTexts.some(t =>
        t.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE),
      )
      logForDebugging(
        `workflow sub-agent terminal API error (${agentDef.agentType}): ${detail}`,
      )
      logEvent('tengu_workflow_agent', { ok: 0 })
      return {
        kind: 'dead',
        reason: promptTooLong ? 'prompt-too-long' : 'api-error',
        detail,
        ...(promptTooLong ? { retryable: false } : {}),
      }
    }

    const finalized = finalizeAgentTool(messages, coreAgentId, {
      prompt: params.prompt,
      resolvedAgentModel: toolUseContext.options.mainLoopModel,
      isBuiltInAgent: isBuiltInAgent(agentDef),
      startTime,
      agentType: agentDef.agentType,
      isAsync: true,
    })
    const outputTokens =
      finalized.usage?.output_tokens ?? finalized.totalTokens ?? 0
    // For panel display: total context tokens, tool-call count, parsed model id at completion.
    const finalTokenCount = finalized.totalTokens ?? 0
    const finalToolCount = finalized.totalToolUseCount ?? 0
    const resolvedModel = model ?? toolUseContext.options.mainLoopModel
    logEvent('tengu_workflow_agent', { ok: 1, outputTokens })

    if (params.schema) {
      const scan = scanStructuredOutput(finalized.content)
      if (scan.value === null) {
        // The agent finished all tool calls but no plain-object JSON was found in the final text block.
        // Typical scenarios: forgot to emit JSON after a long tool chain, unbalanced JSON nesting, parse failure.
        // Put a preview of the last text into detail so the hooks retry log and the panel can immediately see what the agent actually said.
        //
        // When the answer *was* JSON-shaped but syntactically invalid, lead with the parse error and
        // the offending token instead: the preview alone would show a healthy-looking `{"market": …`
        // and send the reader hunting for a missing answer that is actually right there, malformed.
        const preview = scan.malformed
          ? `invalid JSON (${scan.malformed.error}) near: ${scan.malformed.excerpt}`
          : extractTextContent(finalized.content, '\n').slice(0, 200)
        logForDebugging(
          `workflow sub-agent produced no JSON object (${agentDef.agentType}); preview: ${preview}`,
        )
        return {
          kind: 'dead',
          reason: 'no-structured-output',
          detail: preview.slice(0, 300),
        }
      }
      return {
        kind: 'ok',
        output: scan.value as object,
        usage: { outputTokens },
        model: resolvedModel,
        toolCount: finalToolCount,
        tokenCount: finalTokenCount,
      }
    }
    const text = extractTextContent(finalized.content, '\n')
    return {
      kind: 'ok',
      output: text,
      usage: { outputTokens },
      model: resolvedModel,
      toolCount: finalToolCount,
      tokenCount: finalTokenCount,
    }
  },
}
