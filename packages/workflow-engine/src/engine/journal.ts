import { createHash } from 'node:crypto'
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_TOTAL_AGENTS } from '../constants.js'
import type { JournalStore } from '../ports.js'
import type { AgentRunParams, JournalEntry, ResumePolicy } from '../types.js'
import { assertValidRunId } from './paths.js'

type FileJournalStore = JournalStore & {
  rewrite(runId: string, entries: JournalEntry[]): Promise<void>
  deleteRun(runId: string): Promise<void>
}

export class JournalCorruptionError extends Error {
  constructor(runId: string, lineNumber: number, cause: unknown) {
    super(
      `Journal corruption for run ${JSON.stringify(runId)} at line ${lineNumber}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'JournalCorruptionError'
  }
}

/** Canonical parameter string after removing display-only fields. */
function canonicalParams(params: AgentRunParams): string {
  const { label: _label, phase: _phase, ...rest } = params
  const keys = Object.keys(rest).sort()
  const sorted: Record<string, unknown> = {}
  for (const k of keys) sorted[k] = rest[k as keyof typeof rest]
  return JSON.stringify(sorted)
}

/** Determinism key for an agent() call (sha256 of prompt + canonical params). */
export function agentCallKey(prompt: string, params: AgentRunParams): string {
  return createHash('sha256')
    .update(prompt + '\n' + canonicalParams(params))
    .digest('hex')
}

/** Journal identity is positional and content-addressed; neither component is sufficient alone. */
export function journalEntryMatches(
  entry: JournalEntry | undefined,
  seq: number,
  key: string,
): entry is JournalEntry {
  return entry?.seq === seq && entry.key === key
}

export function isSelectiveResumePolicy(
  policy: ResumePolicy,
): policy is Extract<ResumePolicy, { scope: 'range' | 'agents' }> {
  return policy.scope === 'range' || policy.scope === 'agents'
}

export function resumePolicySelectsAgent(
  policy: ResumePolicy,
  agentId: number,
): boolean {
  if (policy.scope === 'all') return true
  if (policy.scope === 'range') {
    return agentId >= policy.fromAgentId && agentId <= policy.toAgentId
  }
  return policy.scope === 'agents' && policy.agentIds.includes(agentId)
}

export function resumePolicyAgentIds(policy: ResumePolicy): number[] {
  if (policy.scope === 'range') {
    return Array.from(
      { length: policy.toAgentId - policy.fromAgentId + 1 },
      (_, index) => policy.fromAgentId + index,
    )
  }
  return policy.scope === 'agents' ? [...policy.agentIds] : []
}

/**
 * Runtime boundary for direct engine callers which do not pass through the Zod tool schema.
 * Omitted policy preserves the historical checkpoint behavior whenever resume=true.
 */
export function resolveResumePolicy(
  value: unknown,
  resume: boolean,
): ResumePolicy | undefined {
  if (value === undefined) return resume ? { scope: 'checkpoint' } : undefined
  if (!resume)
    throw new Error('resumePolicy is valid only with resumeFromRunId')
  if (!isRecord(value) || typeof value.scope !== 'string') {
    throw new Error('Malformed resumePolicy selector')
  }

  if (value.scope === 'checkpoint' || value.scope === 'all') {
    assertExactKeys(value, ['scope'])
    return { scope: value.scope }
  }
  if (value.scope === 'range') {
    assertExactKeys(value, ['scope', 'fromAgentId', 'toAgentId'])
    assertAgentId(value.fromAgentId, 'fromAgentId')
    assertAgentId(value.toAgentId, 'toAgentId')
    if (value.fromAgentId > value.toAgentId) {
      throw new Error('resumePolicy range requires fromAgentId <= toAgentId')
    }
    return {
      scope: 'range',
      fromAgentId: value.fromAgentId,
      toAgentId: value.toAgentId,
    }
  }
  if (value.scope === 'agents') {
    assertExactKeys(value, ['scope', 'agentIds'])
    if (!Array.isArray(value.agentIds) || value.agentIds.length === 0) {
      throw new Error('resumePolicy agents requires a non-empty agentIds array')
    }
    const agentIds: number[] = []
    for (const id of value.agentIds) {
      assertAgentId(id, 'agentIds')
      agentIds.push(id)
    }
    if (new Set(agentIds).size !== agentIds.length) {
      throw new Error('resumePolicy agentIds must be unique')
    }
    return { scope: 'agents', agentIds }
  }
  throw new Error(`Unknown resumePolicy scope ${JSON.stringify(value.scope)}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('Malformed resumePolicy selector')
  }
}

function assertAgentId(value: unknown, field: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value >= MAX_TOTAL_AGENTS
  ) {
    throw new Error(
      `${field} must be an integer between 0 and ${MAX_TOTAL_AGENTS - 1}`,
    )
  }
}

/** File-based JournalStore (jsonl, one directory per run). Pure fs, no core dependencies. */
export function createFileJournalStore(
  runsDir: string,
  warn: (message: string) => void = message => {
    process.emitWarning(message, { code: 'WORKFLOW_JOURNAL_TRUNCATED' })
  },
): FileJournalStore {
  // Every operation derives its path through the validated run directory.
  // This remains required even though truncate only removes the journal file:
  // append/rewrite/deleteRun are persistence boundaries too.
  const dirOf = (runId: string) => join(runsDir, assertValidRunId(runId))
  const pathOf = (runId: string) => join(dirOf(runId), 'journal.jsonl')

  const parseEntries = (runId: string, raw: string): JournalEntry[] => {
    const lines = raw.split('\n')
    const entries: JournalEntry[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line) as unknown
      } catch (error) {
        const isUnterminatedTail = i === lines.length - 1 && !raw.endsWith('\n')
        if (isUnterminatedTail) {
          warn(
            `Ignoring truncated final journal record for run ${JSON.stringify(runId)} at line ${i + 1}`,
          )
          break
        }
        throw new JournalCorruptionError(runId, i + 1, error)
      }
      if (!isJournalEntry(parsed)) {
        throw new JournalCorruptionError(
          runId,
          i + 1,
          new Error('record does not match the journal entry shape'),
        )
      }
      entries.push(parsed)
    }
    return entries
  }

  const rewrite = async (
    runId: string,
    entries: JournalEntry[],
  ): Promise<void> => {
    const dir = dirOf(runId)
    const journalPath = pathOf(runId)
    const tempPath = join(
      dir,
      `.journal.jsonl.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    const body = entries.map(entry => JSON.stringify(entry)).join('\n')
    await mkdir(dir, { recursive: true })
    try {
      await writeFile(tempPath, body.length > 0 ? `${body}\n` : '', 'utf-8')
      await rename(tempPath, journalPath)
    } catch (error) {
      await rm(tempPath, { force: true })
      throw error
    }
  }

  return {
    async read(runId): Promise<JournalEntry[]> {
      let raw: string
      try {
        raw = await readFile(pathOf(runId), 'utf-8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }

      const entries = parseEntries(runId, raw)
      // Dedupe by seq keeping the LAST occurrence in file order: when a resume
      // re-runs a dead entry, hooks appends a superseding record with the same
      // seq — the fresh result must win over the recorded failure.
      // Old entries missing seq fall back to their file index (keeps them
      // distinct and in append order, matching the old all-zero sort behavior).
      const bySeq = new Map<number, JournalEntry>()
      entries.forEach((e, i) => {
        bySeq.set(typeof e.seq === 'number' ? e.seq : i, e)
      })
      // parallel completion order ≠ call order; re-sort by seq so identity matching is stable during resume.
      // Normalize legacy records which omitted seq to their append index: identity now requires both
      // seq and key, so leaving seq undefined would turn every legacy checkpoint into a miss.
      return [...bySeq.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([seq, entry]) => (entry.seq === seq ? entry : { ...entry, seq }))
    },
    async append(runId, entry) {
      await mkdir(dirOf(runId), { recursive: true })
      await appendFile(pathOf(runId), JSON.stringify(entry) + '\n', 'utf-8')
    },
    async truncate(runId) {
      await rm(pathOf(runId), { force: true })
    },
    rewrite,
    async deleteRun(runId) {
      await rm(dirOf(runId), { recursive: true, force: true })
    },
  }
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.key !== 'string') return false
  const seq = entry.seq
  if (
    seq !== undefined &&
    (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0)
  ) {
    return false
  }
  if (typeof entry.result !== 'object' || entry.result === null) return false
  const kind = (entry.result as Record<string, unknown>).kind
  return kind === 'ok' || kind === 'dead' || kind === 'skipped'
}
