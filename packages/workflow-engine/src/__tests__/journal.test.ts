import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentCallKey,
  createFileJournalStore,
  journalEntryMatches,
  JournalCorruptionError,
  resolveResumePolicy,
} from '../engine/journal.js'
import type { AgentRunParams } from '../types.js'

const base: AgentRunParams = { prompt: 'do something' }

test('agentCallKey stable for same prompt+params', () => {
  expect(agentCallKey('p', base)).toBe(agentCallKey('p', base))
})

test('agentCallKey varies with prompt', () => {
  expect(agentCallKey('p1', base)).not.toBe(agentCallKey('p2', base))
})

test('agentCallKey ignores display-only fields label/phase', () => {
  const a = agentCallKey('p', { ...base, label: 'A', phase: 'ph1' })
  const b = agentCallKey('p', { ...base, label: 'B', phase: 'ph2' })
  expect(a).toBe(b)
})

test('journal identity requires both seq and key', () => {
  const entry = {
    key: 'same',
    seq: 4,
    result: { kind: 'dead' as const },
  }
  expect(journalEntryMatches(entry, 4, 'same')).toBe(true)
  expect(journalEntryMatches(entry, 3, 'same')).toBe(false)
  expect(journalEntryMatches(entry, 4, 'different')).toBe(false)
})

test('runtime resume policy validation preserves omitted checkpoint and rejects malformed selectors', () => {
  expect(resolveResumePolicy(undefined, true)).toEqual({ scope: 'checkpoint' })
  expect(resolveResumePolicy({ scope: 'all' }, true)).toEqual({ scope: 'all' })
  expect(() =>
    resolveResumePolicy({ scope: 'agents', agentIds: [1, 1] }, true),
  ).toThrow(/unique/)
  expect(() =>
    resolveResumePolicy({ scope: 'range', fromAgentId: 2, toAgentId: 1 }, true),
  ).toThrow(/fromAgentId/)
  expect(() =>
    resolveResumePolicy({ scope: 'agents', agentIds: [1000] }, true),
  ).toThrow(/between 0 and 999/)
  expect(() => resolveResumePolicy({ scope: 'all' }, false)).toThrow(
    /only with/,
  )
})

test('FileJournalStore append → read preserves order, truncate clears', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-journal-'))
  try {
    const store = createFileJournalStore(dir)
    const e1 = {
      key: 'k1',
      seq: 0,
      result: { kind: 'ok' as const, output: 'x', usage: { outputTokens: 1 } },
    }
    const e2 = { key: 'k2', seq: 1, result: { kind: 'dead' as const } }
    await store.append('run-1', e1)
    await store.append('run-1', e2)
    const got = await store.read('run-1')
    expect(got).toHaveLength(2)
    expect(got[0]!.key).toBe('k1')
    expect(got[1]!.result.kind).toBe('dead')
    await store.truncate('run-1')
    expect(await store.read('run-1')).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FileJournalStore read sorts by seq — resume stable when parallel completion order ≠ call order', async () => {
  // Concurrent completion order is non-deterministic: append-to-disk = completion order; on resume, key matching uses call order.
  // Without seq sorting → different runs have different key orders → nearly all keys mismatch →
  // everything re-runs, journal becomes useless. Fix: read() re-orders by ascending seq before returning.
  const dir = await mkdtemp(join(tmpdir(), 'wf-journal-sort-'))
  try {
    const store = createFileJournalStore(dir)
    await store.append('r1', {
      key: 'late',
      seq: 2,
      result: { kind: 'ok', output: 'late', usage: { outputTokens: 1 } },
    })
    await store.append('r1', {
      key: 'first',
      seq: 0,
      result: { kind: 'ok', output: 'first', usage: { outputTokens: 1 } },
    })
    await store.append('r1', {
      key: 'mid',
      seq: 1,
      result: { kind: 'ok', output: 'mid', usage: { outputTokens: 1 } },
    })
    const got = await store.read('r1')
    expect(got.map(e => e.key)).toEqual(['first', 'mid', 'late'])
    expect(got.map(e => e.seq)).toEqual([0, 1, 2])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FileJournalStore normalizes legacy records without seq to append order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-journal-legacy-seq-'))
  try {
    const runDir = join(dir, 'r1')
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'journal.jsonl'),
      `${JSON.stringify({ key: 'a', result: { kind: 'dead' } })}\n${JSON.stringify({ key: 'b', result: { kind: 'dead' } })}\n`,
      'utf-8',
    )
    expect(
      (await createFileJournalStore(dir).read('r1')).map(entry => entry.seq),
    ).toEqual([0, 1])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('agentCallKey varies with schema', () => {
  const k0 = agentCallKey('p', { prompt: 'p' })
  const k1 = agentCallKey('p', { prompt: 'p', schema: { type: 'object' } })
  const k2 = agentCallKey('p', { prompt: 'p', schema: { type: 'array' } })
  expect(k1).not.toBe(k0)
  expect(k1).not.toBe(k2)
})

test('agentCallKey varies with model', () => {
  expect(agentCallKey('p', { prompt: 'p', model: 'sonnet' })).not.toBe(
    agentCallKey('p', { prompt: 'p', model: 'opus' }),
  )
})

test('agentCallKey stable across params field order (canonical sort)', () => {
  const a = agentCallKey('p', {
    prompt: 'p',
    model: 'm',
    schema: { type: 'object' },
  })
  const b = agentCallKey('p', {
    schema: { type: 'object' },
    prompt: 'p',
    model: 'm',
  })
  expect(a).toBe(b)
})

test('FileJournalStore read dedupes by seq keeping the last occurrence (resume-retry supersede)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-journal-dedupe-'))
  try {
    const store = createFileJournalStore(dir)
    await store.append('r1', {
      key: 'k0',
      seq: 0,
      result: { kind: 'dead', reason: 'api-error' },
    })
    await store.append('r1', {
      key: 'k1',
      seq: 1,
      result: { kind: 'ok', output: 'b', usage: { outputTokens: 1 } },
    })
    // resume re-ran the dead entry and appended the fresh result with the same seq
    await store.append('r1', {
      key: 'k0',
      seq: 0,
      result: { kind: 'ok', output: 'a-retried', usage: { outputTokens: 1 } },
    })
    const got = await store.read('r1')
    expect(got).toHaveLength(2)
    expect(got.map(e => e.seq)).toEqual([0, 1])
    expect(got[0]!.result.kind).toBe('ok')
    expect((got[0]!.result as { output: string }).output).toBe('a-retried')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FileJournalStore read for non-existent run → []', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-journal-'))
  try {
    const store = createFileJournalStore(dir)
    expect(await store.read('never-existed')).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FileJournalStore keeps the valid prefix when the final record is truncated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-journal-tail-'))
  const warnings: string[] = []
  try {
    const runDir = join(dir, 'r1')
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'journal.jsonl'),
      `${JSON.stringify({
        key: 'k0',
        seq: 0,
        result: { kind: 'ok', output: 'saved', usage: { outputTokens: 1 } },
      })}\n{"key":"partial`,
      'utf-8',
    )

    const store = createFileJournalStore(dir, warning => warnings.push(warning))
    const got = await store.read('r1')

    expect(got.map(entry => entry.key)).toEqual(['k0'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/truncated final journal record/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FileJournalStore reports corruption in a middle record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-journal-corrupt-'))
  try {
    const runDir = join(dir, 'r1')
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'journal.jsonl'),
      `${JSON.stringify({ key: 'k0', seq: 0, result: { kind: 'dead' } })}\nnot-json\n${JSON.stringify({ key: 'k2', seq: 2, result: { kind: 'dead' } })}\n`,
      'utf-8',
    )

    const store = createFileJournalStore(dir)
    await expect(store.read('r1')).rejects.toBeInstanceOf(
      JournalCorruptionError,
    )
    await expect(store.read('r1')).rejects.toThrow(/line 2/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FileJournalStore reports a complete but structurally invalid final record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-journal-shape-'))
  try {
    const runDir = join(dir, 'r1')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'journal.jsonl'), '{"key":1}', 'utf-8')

    const store = createFileJournalStore(dir)
    await expect(store.read('r1')).rejects.toThrow(
      /record does not match the journal entry shape/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FileJournalStore does not disguise non-ENOENT read failures as empty history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-journal-io-'))
  try {
    const journalPath = join(dir, 'r1', 'journal.jsonl')
    await mkdir(journalPath, { recursive: true })
    const store = createFileJournalStore(dir)
    await expect(store.read('r1')).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FileJournalStore rewrite preserves sibling script and atomically replaces the journal prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-journal-rewrite-'))
  try {
    const runDir = join(dir, 'r1')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'script.js'), 'return 1', 'utf-8')
    const store = createFileJournalStore(dir)
    await store.append('r1', {
      key: 'old-0',
      seq: 0,
      result: { kind: 'dead' },
    })
    await store.append('r1', {
      key: 'old-1',
      seq: 1,
      result: { kind: 'dead' },
    })

    const prefix = {
      key: 'kept-0',
      seq: 0,
      result: { kind: 'dead' as const },
    }
    await store.rewrite('r1', [prefix])
    await store.append('r1', {
      key: 'new-1',
      seq: 1,
      result: { kind: 'dead' },
    })

    expect((await store.read('r1')).map(entry => entry.key)).toEqual([
      'kept-0',
      'new-1',
    ])
    expect(await readFile(join(runDir, 'script.js'), 'utf-8')).toBe('return 1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FileJournalStore deleteRun is the explicit directory-level cleanup operation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-journal-delete-'))
  try {
    const runDir = join(dir, 'r1')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'script.js'), 'return 1', 'utf-8')
    const store = createFileJournalStore(dir)
    await store.append('r1', {
      key: 'k0',
      seq: 0,
      result: { kind: 'dead' },
    })

    await store.deleteRun('r1')

    await expect(readFile(join(runDir, 'script.js'), 'utf-8')).rejects.toThrow()
    expect(await store.read('r1')).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
