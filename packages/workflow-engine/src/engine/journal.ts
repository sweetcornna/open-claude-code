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

const CHECKPOINT_VERSION = 'v2'
const OCC_IDENTITY_VERSION = 1
const UPSTREAM_IDENTITY_FIELDS = [
  'schema',
  'model',
  'effort',
  'isolation',
  'agentType',
  'disallowedTools',
  'bashCommandClamp',
] as const
const NON_IDENTITY_FIELDS = new Set(['prompt', 'label', 'phase'])

/**
 * Canonical options follow the upstream v2 surface. OCC-only options remain
 * identity-bearing under an explicit compatibility namespace instead of being
 * silently dropped when the upstream whitelist is applied.
 */
function canonicalCheckpointOptions(params: AgentRunParams): string {
  const source = params as Record<string, unknown>
  const options: Record<string, unknown> = {}
  for (const field of UPSTREAM_IDENTITY_FIELDS) {
    const value = source[field]
    if (value === undefined || typeof value === 'function') continue
    options[field] =
      (field === 'disallowedTools' || field === 'bashCommandClamp') &&
      Array.isArray(value)
        ? [...value].sort()
        : value
  }

  const extensions: Record<string, unknown> = {}
  const upstreamFields = new Set<string>(UPSTREAM_IDENTITY_FIELDS)
  for (const field of Object.keys(source)) {
    if (NON_IDENTITY_FIELDS.has(field) || upstreamFields.has(field)) continue
    const value = source[field]
    if (value === undefined || typeof value === 'function') continue
    extensions[field] = value
  }
  if (Object.keys(extensions).length > 0) {
    options.occ = {
      identityVersion: OCC_IDENTITY_VERSION,
      options: extensions,
    }
  }
  return JSON.stringify(canonicalize(options))
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'function') return undefined
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      if (key === '__proto__') continue
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/** Upstream-compatible v2 chained checkpoint key. The first link uses an empty previous key. */
export function agentCallKey(
  prompt: string,
  params: AgentRunParams,
  previousKey = '',
): string {
  const digest = createHash('sha256')
    .update(previousKey)
    .update('\0')
    .update(prompt)
    .update('\0')
    .update(canonicalCheckpointOptions(params))
    .digest('hex')
  return `${CHECKPOINT_VERSION}:${digest}`
}

/** Current OCC key, retained solely for exact migration of pre-v2 journals. */
export function legacyOccAgentCallKey(
  prompt: string,
  params: AgentRunParams,
): string {
  const { label: _label, phase: _phase, ...rest } = params
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(rest).sort()) {
    sorted[key] = rest[key as keyof typeof rest]
  }
  return createHash('sha256')
    .update(`${prompt}\n${JSON.stringify(sorted)}`)
    .digest('hex')
}

export type JournalEntryMatch =
  | { kind: 'v2'; entry: JournalEntry }
  | { kind: 'legacy'; entry: JournalEntry }
  | { kind: 'miss' }

/** Journal identity is positional and content-addressed; neither component is sufficient alone. */
export function journalEntryMatch(
  entry: JournalEntry | undefined,
  seq: number,
  key: string,
  legacyKeys: readonly string[] = [],
): JournalEntryMatch {
  if (entry?.seq !== seq) return { kind: 'miss' }
  if (entry.key === key) return { kind: 'v2', entry }
  return legacyKeys.includes(entry.key)
    ? { kind: 'legacy', entry }
    : { kind: 'miss' }
}

export function journalEntryMatches(
  entry: JournalEntry | undefined,
  seq: number,
  key: string,
  legacyKeys: readonly string[] = [],
): entry is JournalEntry {
  return journalEntryMatch(entry, seq, key, legacyKeys).kind !== 'miss'
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
