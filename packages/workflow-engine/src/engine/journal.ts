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
import type { JournalStore } from '../ports.js'
import type { AgentRunParams, JournalEntry } from '../types.js'
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
      // parallel completion order ≠ call order; re-sort by seq so the key index is stable during resume.
      return [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e)
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
