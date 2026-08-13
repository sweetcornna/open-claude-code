import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWorkflow } from '../engine/runWorkflow.js'
import { AGENT_MAX_RETRIES } from '../constants.js'
import { agentCallKey, createFileJournalStore } from '../engine/journal.js'
import { createHostHandle, type WorkflowPorts } from '../ports.js'
import type {
  AgentRunParams,
  AgentRunResult,
  ProgressEvent,
  ResumePolicy,
} from '../types.js'

function portsWith(
  runsDir: string,
  results: Map<string, AgentRunResult>,
): WorkflowPorts {
  return {
    agentRunner: {
      runAgentToResult: async (p: AgentRunParams) =>
        results.get(p.prompt) ?? { kind: 'dead' },
    },
    progressEmitter: { emit: () => {} },
    taskRegistrar: {
      register: () => ({ runId: 'r', signal: new AbortController().signal }),
      complete: () => {},
      fail: () => {},
      kill: () => {},
      pendingAction: () => null,
    },
    journalStore: createFileJournalStore(runsDir),
    permissionGate: { isAborted: () => false },
    logger: { debug: () => {}, event: () => {} },
    hostFactory: () => ({
      handle: createHostHandle(null),
      cwd: runsDir,
      budgetTotal: null,
    }),
  }
}

function portsWithEvents(
  runsDir: string,
  results: Map<string, AgentRunResult>,
): { ports: WorkflowPorts; events: ProgressEvent[] } {
  const events: ProgressEvent[] = []
  return {
    events,
    ports: {
      agentRunner: {
        runAgentToResult: async (p: AgentRunParams) =>
          results.get(p.prompt) ?? { kind: 'dead' },
      },
      progressEmitter: { emit: e => void events.push(e) },
      taskRegistrar: {
        register: () => ({
          runId: 'r',
          signal: new AbortController().signal,
        }),
        complete: () => {},
        fail: () => {},
        kill: () => {},
        pendingAction: () => null,
      },
      journalStore: createFileJournalStore(runsDir),
      permissionGate: { isAborted: () => false },
      logger: { debug: () => {}, event: () => {} },
      hostFactory: () => ({
        handle: createHostHandle(null),
        cwd: runsDir,
        budgetTotal: null,
      }),
    },
  }
}

test('end-to-end: script returns agent result, status completed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const ports = portsWith(
      dir,
      new Map([
        ['compute', { kind: 'ok', output: '42', usage: { outputTokens: 3 } }],
      ]),
    )
    const result = await runWorkflow({
      script: `export const meta = { name: 't', description: 'd' }\nreturn agent('compute')`,
      runId: 'run-1',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
    })
    expect(result.status).toBe('completed')
    expect(result.returnValue).toBe('42')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('script syntax error → failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const ports = portsWith(dir, new Map())
    const result = await runWorkflow({
      script: `export const meta = { name: 't', description: 'd' }\nreturn ((`,
      runId: 'run-2',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toBeTruthy()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resume: journal hit skips runner call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    let called = 0
    const ports: WorkflowPorts = {
      agentRunner: {
        runAgentToResult: async () => {
          called++
          return { kind: 'ok', output: 'live', usage: { outputTokens: 1 } }
        },
      },
      progressEmitter: { emit: () => {} },
      taskRegistrar: {
        register: () => ({ runId: 'r', signal: new AbortController().signal }),
        complete: () => {},
        fail: () => {},
        kill: () => {},
        pendingAction: () => null,
      },
      journalStore: createFileJournalStore(dir),
      permissionGate: { isAborted: () => false },
      logger: { debug: () => {}, event: () => {} },
      hostFactory: () => ({
        handle: createHostHandle(null),
        cwd: dir,
        budgetTotal: null,
      }),
    }
    const key = agentCallKey('compute', { prompt: 'compute' })
    await ports.journalStore.append('run-3', {
      key,
      seq: 0,
      result: { kind: 'ok', output: 'cached', usage: { outputTokens: 1 } },
    })

    const result = await runWorkflow({
      script: `return agent('compute')`,
      runId: 'run-3',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
    })
    expect(result.status).toBe('completed')
    expect(result.returnValue).toBe('cached')
    expect(called).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test.each([
  [{ scope: 'all' } as const, ['a', 'b', 'c'], 0],
  [{ scope: 'range', fromAgentId: 1, toAgentId: 1 } as const, ['b'], 2],
  [{ scope: 'agents', agentIds: [0, 2] } as ResumePolicy, ['a', 'c'], 1],
])('selective resume policy %o reports live/replay execution and counts', async (resumePolicy, expectedLive, replayedCount) => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-policy-'))
  try {
    const events: ProgressEvent[] = []
    const live: string[] = []
    const ports = portsWith(dir, new Map())
    ports.progressEmitter = { emit: event => void events.push(event) }
    ports.agentRunner = {
      runAgentToResult: async params => {
        live.push(params.prompt)
        return {
          kind: 'ok',
          output: `same:${params.prompt}`,
          usage: { outputTokens: 1 },
        }
      },
    }
    let previousKey = ''
    for (const [seq, prompt] of ['a', 'b', 'c'].entries()) {
      const key = agentCallKey(prompt, { prompt }, previousKey)
      previousKey = key
      await ports.journalStore.append('run-policy', {
        key,
        seq,
        result: {
          kind: 'ok',
          output: `same:${prompt}`,
          usage: { outputTokens: 1 },
        },
      })
    }

    const result = await runWorkflow({
      script: `return [await agent('a'), await agent('b'), await agent('c')]`,
      runId: 'run-policy',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
      resumePolicy,
    })

    expect(live).toEqual(expectedLive)
    expect(result.resume).toEqual({
      policy: resumePolicy,
      replayedCount,
      liveCount: expectedLive.length,
      selectorsNotReached: [],
    })
    expect(
      events
        .filter(event => event.type === 'agent_done')
        .map(event => event.execution),
    ).toEqual(
      ['a', 'b', 'c'].map(prompt =>
        expectedLive.includes(prompt) ? 'live' : 'replayed',
      ),
    )
    const done = events.find(event => event.type === 'run_done')
    expect(done?.type === 'run_done' ? done.resume : undefined).toEqual(
      result.resume,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('omitted and explicit checkpoint policies preserve replay-completed behavior', async () => {
  for (const resumePolicy of [undefined, { scope: 'checkpoint' } as const]) {
    const dir = await mkdtemp(join(tmpdir(), 'wf-run-checkpoint-'))
    try {
      let calls = 0
      const ports = portsWith(dir, new Map())
      ports.agentRunner = {
        runAgentToResult: async () => {
          calls++
          return { kind: 'ok', output: 'live', usage: { outputTokens: 1 } }
        },
      }
      await ports.journalStore.append('run-checkpoint', {
        key: agentCallKey('a', { prompt: 'a' }),
        seq: 0,
        result: {
          kind: 'ok',
          output: 'cached',
          usage: { outputTokens: 1 },
        },
      })
      const result = await runWorkflow({
        script: `return agent('a')`,
        runId: 'run-checkpoint',
        ports,
        host: createHostHandle(null),
        signal: new AbortController().signal,
        cwd: dir,
        budgetTotal: null,
        resume: true,
        ...(resumePolicy ? { resumePolicy } : {}),
      })
      expect(result.returnValue).toBe('cached')
      expect(result.resume?.replayedCount).toBe(1)
      expect(result.resume?.liveCount).toBe(0)
      expect(calls).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test('dead call closes the successful checkpoint prefix and reruns the suffix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-dead-'))
  try {
    const live: string[] = []
    const ports = portsWith(dir, new Map())
    ports.agentRunner = {
      runAgentToResult: async params => {
        live.push(params.prompt)
        return { kind: 'dead', reason: 'api-error' }
      },
    }
    const deadKey = agentCallKey('a', { prompt: 'a' })
    await ports.journalStore.append('run-dead', {
      key: deadKey,
      seq: 0,
      result: { kind: 'dead', reason: 'api-error' },
    })
    await ports.journalStore.append('run-dead', {
      key: agentCallKey('b', { prompt: 'b' }, deadKey),
      seq: 1,
      result: {
        kind: 'ok',
        output: 'cached:b',
        usage: { outputTokens: 1 },
      },
    })

    const result = await runWorkflow({
      script: `return [await agent('a'), await agent('b')]`,
      runId: 'run-dead',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
      agentMaxRetries: 0,
      autoRetryOnFailure: false,
    })

    expect(result.returnValue).toEqual([null, null])
    expect(live).toEqual(['a', 'b'])
    expect(result.resume?.liveCount).toBe(2)
    expect(result.resume?.replayedCount).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('changed selected output reruns the divergent suffix and rewrites only the authoritative seq records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-divergence-'))
  try {
    const live: string[] = []
    const ports = portsWith(dir, new Map())
    ports.agentRunner = {
      runAgentToResult: async params => {
        live.push(params.prompt)
        return {
          kind: 'ok',
          output: params.prompt === 'first' ? 'new' : `live:${params.prompt}`,
          usage: { outputTokens: 1 },
        }
      },
    }
    const firstKey = agentCallKey('first', { prompt: 'first' })
    await ports.journalStore.append('run-divergence', {
      key: firstKey,
      seq: 0,
      result: { kind: 'ok', output: 'old', usage: { outputTokens: 1 } },
    })
    await ports.journalStore.append('run-divergence', {
      key: agentCallKey('second:old', { prompt: 'second:old' }, firstKey),
      seq: 1,
      result: {
        kind: 'ok',
        output: 'cached:old-suffix',
        usage: { outputTokens: 1 },
      },
    })

    const result = await runWorkflow({
      script: `const first = await agent('first')\nreturn agent('second:' + first)`,
      runId: 'run-divergence',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
      resumePolicy: { scope: 'agents', agentIds: [0] },
    })

    expect(result.returnValue).toBe('live:second:new')
    expect(live).toEqual(['first', 'second:new'])
    expect(result.resume?.liveCount).toBe(2)
    expect(result.resume?.replayedCount).toBe(0)
    const finalJournal = await ports.journalStore.read('run-divergence')
    expect(finalJournal.map(entry => entry.seq)).toEqual([0, 1])
    expect(finalJournal.map(entry => entry.key)).toEqual([
      firstKey,
      agentCallKey('second:new', { prompt: 'second:new' }, firstKey),
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** Seed `count` checkpoints for `runId`, one per `a<seq>` prompt. */
async function seedJournal(
  ports: WorkflowPorts,
  runId: string,
  count: number,
  deadSeq?: number,
): Promise<void> {
  let previousKey = ''
  for (let seq = 0; seq < count; seq++) {
    const prompt = `a${seq}`
    const key = agentCallKey(prompt, { prompt }, previousKey)
    previousKey = key
    await ports.journalStore.append(runId, {
      key,
      seq,
      result:
        seq === deadSeq
          ? { kind: 'dead', reason: 'api-error' }
          : {
              kind: 'ok',
              output: `cached:${seq}`,
              usage: { outputTokens: 1 },
            },
    })
  }
}

const SEQUENTIAL_AGENTS = (count: number): string =>
  `const out = []\nfor (let i = 0; i < ${count}; i++) out.push(await agent('a' + i))\nreturn out`

test('kill during a resume keeps every checkpoint the attempt never reached', async () => {
  // The reported data loss: a 10-agent run whose agent 3 died, resumed, cancelled
  // with x while agent 3 was back in flight — and the journal came back holding only
  // the three entries the attempt had touched. Stopping early says nothing about
  // whether checkpoints 4..9 are still valid, so they must survive.
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-abort-resume-'))
  try {
    const ac = new AbortController()
    const { ports, events } = portsWithEvents(dir, new Map())
    ports.agentRunner = {
      runAgentToResult: async () => {
        ac.abort()
        throw new Error('cancelled by user')
      },
    }
    await seedJournal(ports, 'run-abort', 5, 2)

    const result = await runWorkflow({
      script: SEQUENTIAL_AGENTS(5),
      runId: 'run-abort',
      ports,
      host: createHostHandle(null),
      signal: ac.signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
      agentMaxRetries: 0,
    })

    expect(result.status).toBe('killed')
    const journal = await ports.journalStore.read('run-abort')
    expect(journal.map(entry => entry.seq)).toEqual([0, 1, 2, 3, 4])
    // Nor may it be *reported* as a divergence: the cancelled rerun produced no
    // output to disagree with the recorded one.
    expect(
      events.some(e => e.type === 'log' && e.message.includes('diverged')),
    ).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('budget exhaustion during a selective resume keeps the cached tail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-budget-resume-'))
  try {
    const ports = portsWith(dir, new Map())
    await seedJournal(ports, 'run-budget', 4)

    const result = await runWorkflow({
      script: SEQUENTIAL_AGENTS(4),
      runId: 'run-budget',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: 0,
      resume: true,
      resumePolicy: { scope: 'agents', agentIds: [1] },
    })

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/budget/)
    expect(
      (await ports.journalStore.read('run-budget')).map(entry => entry.seq),
    ).toEqual([0, 1, 2, 3])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a killed scope "all" rerun keeps the checkpoints it never reached', async () => {
  // scope "all" pre-marks the whole journal for replacement, which is only earned by
  // an attempt that actually reruns everything. Cut short, it may replace only what
  // it produced.
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-all-abort-'))
  try {
    const ac = new AbortController()
    const ports = portsWith(dir, new Map())
    let live = 0
    ports.agentRunner = {
      runAgentToResult: async params => {
        live++
        if (live === 2) {
          ac.abort()
          throw new Error('cancelled by user')
        }
        return {
          kind: 'ok',
          output: `live:${params.prompt}`,
          usage: { outputTokens: 1 },
        }
      },
    }
    await seedJournal(ports, 'run-all-abort', 4)

    const result = await runWorkflow({
      script: SEQUENTIAL_AGENTS(4),
      runId: 'run-all-abort',
      ports,
      host: createHostHandle(null),
      signal: ac.signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
      resumePolicy: { scope: 'all' },
      agentMaxRetries: 0,
    })

    expect(result.status).toBe('killed')
    const journal = await ports.journalStore.read('run-all-abort')
    expect(
      journal.map(entry =>
        entry.result.kind === 'ok' ? entry.result.output : entry.result.kind,
      ),
    ).toEqual(['live:a0', 'cached:1', 'cached:2', 'cached:3'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a completed scope "all" rerun still drops the tail the new script no longer produces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-all-shrink-'))
  try {
    const ports = portsWith(
      dir,
      new Map([
        ['a0', { kind: 'ok', output: 'live:a0', usage: { outputTokens: 1 } }],
      ]),
    )
    await seedJournal(ports, 'run-all-shrink', 3)

    const result = await runWorkflow({
      script: SEQUENTIAL_AGENTS(1),
      runId: 'run-all-shrink',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
      resumePolicy: { scope: 'all' },
    })

    expect(result.status).toBe('completed')
    const journal = await ports.journalStore.read('run-all-shrink')
    expect(journal.map(entry => entry.seq)).toEqual([0])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('selectors not reached are reported in the result and terminal progress event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-not-reached-'))
  try {
    const { ports, events } = portsWithEvents(
      dir,
      new Map([['a', { kind: 'ok', output: 'a', usage: { outputTokens: 1 } }]]),
    )
    await ports.journalStore.append('run-not-reached', {
      key: agentCallKey('a', { prompt: 'a' }),
      seq: 0,
      result: { kind: 'ok', output: 'a', usage: { outputTokens: 1 } },
    })
    const result = await runWorkflow({
      script: `return agent('a')`,
      runId: 'run-not-reached',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
      resumePolicy: { scope: 'agents', agentIds: [0, 4, 7] },
    })
    expect(result.resume?.selectorsNotReached).toEqual([4, 7])
    const done = events.find(event => event.type === 'run_done')
    expect(
      done?.type === 'run_done' ? done.resume?.selectorsNotReached : undefined,
    ).toEqual([4, 7])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('direct engine rejects malformed selectors and changed-script selective resume without truncating', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-invalid-policy-'))
  try {
    const ports = portsWith(dir, new Map())
    await ports.journalStore.append('run-invalid-policy', {
      key: agentCallKey('a', { prompt: 'a' }),
      seq: 0,
      result: { kind: 'ok', output: 'cached', usage: { outputTokens: 1 } },
    })
    const malformed = await runWorkflow({
      script: `return agent('a')`,
      runId: 'run-invalid-policy',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
      resumePolicy: {
        scope: 'agents',
        agentIds: [1, 1],
      } as unknown as import('../types.js').ResumePolicy,
    })
    expect(malformed.status).toBe('failed')
    expect(malformed.error).toMatch(/unique/)

    const changed = await runWorkflow({
      script: `return agent('a')`,
      runId: 'run-invalid-policy',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
      resumePolicy: { scope: 'range', fromAgentId: 0, toAgentId: 0 },
      scriptChanged: true,
    })
    expect(changed.status).toBe('failed')
    expect(changed.error).toMatch(/unchanged workflow script/)
    expect(await ports.journalStore.read('run-invalid-policy')).toHaveLength(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('abort → killed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const ports = portsWith(
      dir,
      new Map([['x', { kind: 'ok', output: '1', usage: { outputTokens: 1 } }]]),
    )
    const ac = new AbortController()
    ac.abort()
    const result = await runWorkflow({
      script: `return agent('x')`,
      runId: 'run-4',
      ports,
      host: createHostHandle(null),
      signal: ac.signal,
      cwd: dir,
      budgetTotal: null,
    })
    expect(result.status).toBe('killed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('workflow() nesting (one level) shares counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    await mkdir(join(dir, '.occ', 'workflows'), { recursive: true })
    await writeFile(
      join(dir, '.occ', 'workflows', 'child.ts'),
      `return agent('child')\n// child workflow`,
    )
    const ports = portsWith(
      dir,
      new Map([
        [
          'child',
          { kind: 'ok', output: 'child-out', usage: { outputTokens: 1 } },
        ],
      ]),
    )
    const result = await runWorkflow({
      script: `return workflow('child')`,
      runId: 'run-5',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
    })
    expect(result.status).toBe('completed')
    expect(result.returnValue).toBe('child-out')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- boundary and events ----

test('changed default resume replays a matching agent prefix through post-processing edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    let called = 0
    const ports = portsWith(dir, new Map())
    ports.agentRunner.runAgentToResult = async () => {
      called++
      return { kind: 'ok', output: 'live', usage: { outputTokens: 1 } }
    }
    await ports.journalStore.append('run-changed-postprocess', {
      key: agentCallKey('compute', { prompt: 'compute' }),
      seq: 0,
      result: { kind: 'ok', output: 'cached', usage: { outputTokens: 1 } },
    })

    const result = await runWorkflow({
      script: `const value = await agent('compute'); return value + '!'`,
      runId: 'run-changed-postprocess',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
      scriptChanged: true,
    })

    expect(result.status).toBe('completed')
    expect(result.returnValue).toBe('cached!')
    expect(result.resume?.replayedCount).toBe(1)
    expect(called).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scope all reruns live without eagerly truncating a changed-script journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    let called = 0
    const ports: WorkflowPorts = {
      agentRunner: {
        runAgentToResult: async () => {
          called++
          return { kind: 'ok', output: 'live', usage: { outputTokens: 1 } }
        },
      },
      progressEmitter: { emit: () => {} },
      taskRegistrar: {
        register: () => ({ runId: 'r', signal: new AbortController().signal }),
        complete: () => {},
        fail: () => {},
        kill: () => {},
        pendingAction: () => null,
      },
      journalStore: createFileJournalStore(dir),
      permissionGate: { isAborted: () => false },
      logger: { debug: () => {}, event: () => {} },
      hostFactory: () => ({
        handle: createHostHandle(null),
        cwd: dir,
        budgetTotal: null,
      }),
    }
    const key = agentCallKey('compute', { prompt: 'compute' })
    await ports.journalStore.append('run-chg', {
      key,
      seq: 0,
      result: { kind: 'ok', output: 'cached', usage: { outputTokens: 1 } },
    })
    const scriptPath = join(dir, 'run-chg', 'script.js')
    await writeFile(scriptPath, `return agent('compute')`)
    const result = await runWorkflow({
      script: `return agent('compute')`,
      runId: 'run-chg',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
      resumePolicy: { scope: 'all' },
      scriptChanged: true,
    })
    expect(result.status).toBe('completed')
    expect(result.returnValue).toBe('live')
    expect(called).toBe(1)
    // The live result supersedes the old record at the same sequence without a
    // destructive pre-run truncate window.
    const final = await ports.journalStore.read('run-chg')
    expect(final).toHaveLength(1)
    expect((final[0]!.result as { output: string }).output).toBe('live')
    expect(await readFile(scriptPath, 'utf-8')).toBe(`return agent('compute')`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('script runtime throw (non-syntax error) → failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const ports = portsWith(dir, new Map())
    const result = await runWorkflow({
      script: `throw new Error('boom at runtime')`,
      runId: 'run-throw',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/boom/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('emits run_started (with workflowName) and run_done events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const { ports, events } = portsWithEvents(
      dir,
      new Map([['x', { kind: 'ok', output: '1', usage: { outputTokens: 1 } }]]),
    )
    await runWorkflow({
      script: `return agent('x')`,
      runId: 'run-ev',
      workflowName: 'my-wf',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
    })
    expect(
      events.some(e => e.type === 'run_started' && e.workflowName === 'my-wf'),
    ).toBe(true)
    expect(
      events.some(e => e.type === 'run_done' && e.status === 'completed'),
    ).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Emit phase_done for currentPhase before terminal state: hook.phase only emits the previous phase's done on switch,
// the last phase has no subsequent switch → the UI left panel would show running forever. Verify all three paths re-emit.
test('re-emit phase_done for currentPhase before terminal state (completed path)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const { ports, events } = portsWithEvents(
      dir,
      new Map([['x', { kind: 'ok', output: '1', usage: { outputTokens: 1 } }]]),
    )
    await runWorkflow({
      script: `phase('Review')\nreturn agent('x')`,
      runId: 'run-phase-done',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
    })
    // Both phase_started and phase_done for Review should be present (done from re-emit before terminal)
    expect(
      events.some(e => e.type === 'phase_started' && e.phase === 'Review'),
    ).toBe(true)
    expect(
      events.some(e => e.type === 'phase_done' && e.phase === 'Review'),
    ).toBe(true)
    // Order: phase_done must precede run_done (reducer is order-independent, but the event stream is clearer this way)
    const lastPhaseDone = Math.max(
      0,
      ...events.map((e, i) => (e.type === 'phase_done' ? i : -1)),
    )
    const runDoneIdx = events.findIndex(e => e.type === 'run_done')
    expect(runDoneIdx).toBeGreaterThan(0)
    expect(lastPhaseDone).toBeLessThan(runDoneIdx)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('re-emit phase_done for currentPhase before terminal state (killed path)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const { ports, events } = portsWithEvents(
      dir,
      new Map([['x', { kind: 'ok', output: '1', usage: { outputTokens: 1 } }]]),
    )
    const ac = new AbortController()
    ac.abort()
    await runWorkflow({
      script: `phase('Run')\nreturn agent('x')`,
      runId: 'run-kill-phase',
      ports,
      host: createHostHandle(null),
      signal: ac.signal,
      cwd: dir,
      budgetTotal: null,
    })
    expect(events.some(e => e.type === 'phase_done' && e.phase === 'Run')).toBe(
      true,
    )
    expect(
      events.some(e => e.type === 'run_done' && e.status === 'killed'),
    ).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('no phase() call → terminal does not re-emit phase_done (currentPhase is null)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const { ports, events } = portsWithEvents(
      dir,
      new Map([['x', { kind: 'ok', output: '1', usage: { outputTokens: 1 } }]]),
    )
    await runWorkflow({
      script: `return agent('x')`,
      runId: 'run-no-phase',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
    })
    // No phase() → currentPhase is null → terminal does not re-emit phase_done
    expect(events.some(e => e.type === 'phase_done')).toBe(false)
    expect(events.some(e => e.type === 'phase_started')).toBe(false)
    expect(
      events.some(e => e.type === 'run_done' && e.status === 'completed'),
    ).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('derives workflowName from meta.name when not passed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const { ports, events } = portsWithEvents(dir, new Map())
    await runWorkflow({
      script: `export const meta = { name: 'from-meta', description: 'd' }\nreturn 1`,
      runId: 'run-meta',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
    })
    expect(
      events.some(
        e => e.type === 'run_started' && e.workflowName === 'from-meta',
      ),
    ).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('budgetTotal exhausted → failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const ports = portsWith(
      dir,
      new Map([
        ['a', { kind: 'ok', output: '1', usage: { outputTokens: 5 } }],
        ['b', { kind: 'ok', output: '2', usage: { outputTokens: 5 } }],
      ]),
    )
    const result = await runWorkflow({
      script: `await agent('a')\nreturn agent('b')`,
      runId: 'run-budget',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: 5,
    })
    expect(result.status).toBe('failed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('maxConcurrency passthrough: parallel agents bounded by run-level concurrency slots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    let active = 0
    let peak = 0
    const ports: WorkflowPorts = {
      agentRunner: {
        runAgentToResult: async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise(r => {
            setTimeout(r, 8)
          })
          active--
          return { kind: 'ok', output: 'x', usage: { outputTokens: 1 } }
        },
      },
      progressEmitter: { emit: () => {} },
      taskRegistrar: {
        register: () => ({ runId: 'r', signal: new AbortController().signal }),
        complete: () => {},
        fail: () => {},
        kill: () => {},
        pendingAction: () => null,
      },
      journalStore: createFileJournalStore(dir),
      permissionGate: { isAborted: () => false },
      logger: { debug: () => {}, event: () => {} },
      hostFactory: () => ({
        handle: createHostHandle(null),
        cwd: dir,
        budgetTotal: null,
      }),
    }
    const result = await runWorkflow({
      script: `return parallel(Array.from({length: 8}, () => () => agent('p')))`,
      runId: 'run-mc',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      maxConcurrency: 2,
    })
    expect(result.status).toBe('completed')
    expect(peak).toBeLessThanOrEqual(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('workflow() references a syntactically broken sub-script → failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    await mkdir(join(dir, '.occ', 'workflows'), { recursive: true })
    await writeFile(join(dir, '.occ', 'workflows', 'broken.ts'), `return ((`)
    const ports = portsWith(dir, new Map())
    const result = await runWorkflow({
      script: `return workflow('broken')`,
      runId: 'run-sub-err',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/Sub-workflow|script error/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('workflow() resolves sub-workflows from a host-provided directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const workflowDir = join('.custom', 'workflows')
    await mkdir(join(dir, workflowDir), { recursive: true })
    await writeFile(join(dir, workflowDir, 'nested.js'), 'return 7')
    const ports = portsWith(dir, new Map())
    const result = await runWorkflow({
      script: `return workflow('nested')`,
      runId: 'run-sub-occ',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      workflowDir,
    })
    expect(result).toEqual({ status: 'completed', returnValue: 7 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- automatic journal-resume on failure ----

test('auto-retry: agent failure crashes the script → second attempt replays journal and re-runs only the failure → completed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-autoretry-'))
  try {
    // 'a' always succeeds; 'b' dies through the whole in-place retry budget (initial +
    // AGENT_MAX_RETRIES) on the first attempt, then succeeds. The script explodes on b's
    // null (property access), triggering the automatic journal-resume: attempt 2 replays
    // 'a' from the journal (no live call) and re-runs 'b'.
    let aCalls = 0
    let bCalls = 0
    const ports: WorkflowPorts = {
      agentRunner: {
        runAgentToResult: async (p: AgentRunParams) => {
          if (p.prompt === 'a') {
            aCalls++
            return {
              kind: 'ok',
              output: { value: 'A' },
              usage: { outputTokens: 1 },
            }
          }
          bCalls++
          return bCalls <= 1 + AGENT_MAX_RETRIES
            ? { kind: 'dead', reason: 'api-error' }
            : {
                kind: 'ok',
                output: { value: 'B' },
                usage: { outputTokens: 1 },
              }
        },
      },
      progressEmitter: { emit: () => {} },
      taskRegistrar: {
        register: () => ({ runId: 'r', signal: new AbortController().signal }),
        complete: () => {},
        fail: () => {},
        kill: () => {},
        pendingAction: () => null,
      },
      journalStore: createFileJournalStore(dir),
      permissionGate: { isAborted: () => false },
      logger: { debug: () => {}, event: () => {} },
      hostFactory: () => ({
        handle: createHostHandle(null),
        cwd: dir,
        budgetTotal: null,
      }),
    }
    const result = await runWorkflow({
      script: `const a = await agent('a')\nconst b = await agent('b')\nreturn a.value + b.value`,
      runId: 'run-autoretry',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      retryBackoffMs: 0,
    })
    expect(result.status).toBe('completed')
    expect(result.returnValue).toBe('AB')
    // 'a' ran live exactly once (attempt 2 replayed it from the journal)
    expect(aCalls).toBe(1)
    // 'b': attempt 1 = initial + AGENT_MAX_RETRIES in-place retries (all dead),
    // attempt 2 = fresh run (ok)
    expect(bCalls).toBe(1 + AGENT_MAX_RETRIES + 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto-retry emits a log event and a single run_done', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-autoretry-ev-'))
  try {
    const { ports, events } = portsWithEvents(dir, new Map())
    const result = await runWorkflow({
      script: `throw new Error('script exploded')`,
      runId: 'run-autoretry-ev',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      retryBackoffMs: 0,
    })
    expect(result.status).toBe('failed')
    expect(
      events.some(
        e =>
          e.type === 'log' && /auto-resuming once from journal/.test(e.message),
      ),
    ).toBe(true)
    expect(events.filter(e => e.type === 'run_done')).toHaveLength(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto-retry disabled via autoRetryOnFailure:false → single attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-autoretry-off-'))
  try {
    let calls = 0
    const ports = portsWith(dir, new Map())
    const origEmit = ports.progressEmitter.emit
    const events: ProgressEvent[] = []
    ports.progressEmitter = {
      emit: e => {
        events.push(e)
        origEmit(e)
      },
    }
    ports.agentRunner = {
      runAgentToResult: async () => {
        calls++
        return { kind: 'dead', reason: 'api-error' }
      },
    }
    const result = await runWorkflow({
      script: `const r = await agent('x')\nreturn r.value`,
      runId: 'run-autoretry-off',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      retryBackoffMs: 0,
      autoRetryOnFailure: false,
    })
    expect(result.status).toBe('failed')
    // initial + the in-place retry budget only; no second script attempt
    expect(calls).toBe(1 + AGENT_MAX_RETRIES)
    // in-place retries do log (that is how the panel shows them), but the workflow-level
    // journal resume must not have happened
    expect(
      events.some(
        e =>
          e.type === 'log' && /auto-resuming once from journal/.test(e.message),
      ),
    ).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto-retry NOT triggered for deterministic failures (WorkflowError / budget)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-autoretry-det-'))
  try {
    const { ports, events } = portsWithEvents(
      dir,
      new Map([
        ['a', { kind: 'ok', output: '1', usage: { outputTokens: 5 } }],
        ['b', { kind: 'ok', output: '2', usage: { outputTokens: 5 } }],
      ]),
    )
    const result = await runWorkflow({
      script: `await agent('a')\nreturn agent('b')`,
      runId: 'run-autoretry-det',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: 5,
      retryBackoffMs: 0,
    })
    expect(result.status).toBe('failed')
    // BudgetExhaustedError → not retry-eligible → no auto-resume log
    expect(events.some(e => e.type === 'log')).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('workflow() references a non-existent name → failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const ports = portsWith(dir, new Map())
    const result = await runWorkflow({
      script: `return workflow('ghost')`,
      runId: 'run-sub-missing',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/Sub-workflow|not found/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('changed default resume uses checkpoint identity without announcing journal discard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-run-'))
  try {
    const events: ProgressEvent[] = []
    const warnings: string[] = []
    const ports: WorkflowPorts = {
      agentRunner: {
        runAgentToResult: async () => ({
          kind: 'ok',
          output: 'live',
          usage: { outputTokens: 1 },
        }),
      },
      progressEmitter: { emit: e => void events.push(e) },
      taskRegistrar: {
        register: () => ({ runId: 'r', signal: new AbortController().signal }),
        complete: () => {},
        fail: () => {},
        kill: () => {},
        pendingAction: () => null,
      },
      journalStore: createFileJournalStore(dir),
      permissionGate: { isAborted: () => false },
      logger: {
        debug: () => {},
        event: () => {},
        warn: msg => void warnings.push(msg),
      },
      hostFactory: () => ({
        handle: createHostHandle(null),
        cwd: dir,
        budgetTotal: null,
      }),
    }
    await runWorkflow({
      script: `return agent('compute')`,
      runId: 'run-say-so',
      ports,
      host: createHostHandle(null),
      signal: new AbortController().signal,
      cwd: dir,
      budgetTotal: null,
      resume: true,
      scriptChanged: true,
    })

    expect(warnings.some(w => w.includes('journal discarded'))).toBe(false)
    expect(
      events.some(
        e => e.type === 'log' && e.message.includes('journal discarded'),
      ),
    ).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
