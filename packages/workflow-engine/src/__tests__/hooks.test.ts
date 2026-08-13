import { expect, test } from 'bun:test'
import { AgentAdapterRegistry } from '../agentAdapter.js'
import { createEngineContext } from '../engine/context.js'
import { maxConcurrency, Semaphore } from '../engine/concurrency.js'
import { agentCallKey, legacyOccAgentCallKey } from '../engine/journal.js'
import { makeHooks, type SubWorkflowRunner } from '../engine/hooks.js'
import { AGENT_MAX_RETRIES, AGENT_MAX_RETRIES_BY_REASON } from '../constants.js'
import { WorkflowError, WorkflowAbortedError } from '../engine/errors.js'
import { createBufferingEmitter } from '../progress/events.js'
import { createHostHandle, type WorkflowPorts } from '../ports.js'
import type {
  AgentRunParams,
  AgentRunResult,
  JournalEntry,
  ProgressEvent,
  ResumePolicy,
} from '../types.js'

type CtxOverrides = Partial<{
  agentResults: Map<string, AgentRunResult>
  runner: (params: AgentRunParams) => Promise<AgentRunResult>
  pending: { kind: 'skip' | 'retry' } | null
  journal: JournalEntry[]
  resumePolicy: ResumePolicy
  budgetTotal: number | null
  signal: AbortSignal
  truncated: string[]
  appended: JournalEntry[]
  rewritten: Array<{ runId: string; entries: JournalEntry[] }>
  agentAdapterRegistry: AgentAdapterRegistry
  loggerWarn: (msg: string) => void
  /** In-place retries per agent() call; undefined → engine default (AGENT_MAX_RETRIES). */
  agentMaxRetries: number
  /** Base retry backoff; defaults to 0 here so retry suites do not actually wait. */
  retryBackoffMs: number
  // taskRegistrar agent-level abort binding (agent kill bridge).
  // When provided, buildCtx injects it into ports.taskRegistrar; hooks.agent pushes the closure into adapterCtx.
  registerAgentAbort: (
    runId: string,
    agentId: number,
    ac: AbortController,
  ) => void
  unregisterAgentAbort: (runId: string, agentId: number) => void
}>

function checkpointJournal(
  prompts: string[],
  result: (prompt: string, seq: number) => AgentRunResult,
): JournalEntry[] {
  let previousKey = ''
  return prompts.map((prompt, seq) => {
    const key = agentCallKey(prompt, { prompt }, previousKey)
    previousKey = key
    return { key, seq, result: result(prompt, seq) }
  })
}

function buildCtx(overrides: CtxOverrides = {}): {
  ctx: ReturnType<typeof createEngineContext>
  events: ProgressEvent[]
  hooks: ReturnType<typeof makeHooks>
} {
  const { emitter, events } = createBufferingEmitter()
  const results = overrides.agentResults ?? new Map<string, AgentRunResult>()
  const ports: WorkflowPorts = {
    agentRunner: {
      runAgentToResult: overrides.runner
        ? overrides.runner
        : async (params: AgentRunParams) =>
            results.get(params.prompt) ?? { kind: 'dead' },
    },
    ...(overrides.agentAdapterRegistry
      ? { agentAdapterRegistry: overrides.agentAdapterRegistry }
      : {}),
    progressEmitter: emitter,
    taskRegistrar: {
      register: () => ({ runId: 'r', signal: new AbortController().signal }),
      complete: () => {},
      fail: () => {},
      kill: () => {},
      pendingAction: () => overrides.pending ?? null,
      ...(overrides.registerAgentAbort
        ? { registerAgentAbort: overrides.registerAgentAbort }
        : {}),
      ...(overrides.unregisterAgentAbort
        ? { unregisterAgentAbort: overrides.unregisterAgentAbort }
        : {}),
    },
    journalStore: {
      read: async () => [],
      append: async (_id: string, entry: JournalEntry) => {
        overrides.appended?.push(entry)
      },
      truncate: async (id: string) => {
        overrides.truncated?.push(id)
      },
      ...(overrides.rewritten
        ? {
            rewrite: async (runId: string, entries: JournalEntry[]) => {
              overrides.rewritten?.push({
                runId,
                entries: entries.map(entry => ({ ...entry })),
              })
            },
          }
        : {}),
    },
    permissionGate: { isAborted: () => false },
    logger: {
      debug: () => {},
      event: () => {},
      ...(overrides.loggerWarn ? { warn: overrides.loggerWarn } : {}),
    },
    hostFactory: () => ({
      handle: createHostHandle(null),
      cwd: '/tmp',
      budgetTotal: null,
    }),
  }
  const ctx = createEngineContext({
    ports,
    host: createHostHandle(null),
    signal: overrides.signal ?? new AbortController().signal,
    runId: 'r1',
    workflowName: 'w',
    cwd: '/tmp',
    budgetTotal: overrides.budgetTotal ?? null,
    journal: overrides.journal,
    ...(overrides.resumePolicy ? { resumePolicy: overrides.resumePolicy } : {}),
    retryBackoffMs: overrides.retryBackoffMs ?? 0, // keep retry tests instant
    ...(overrides.agentMaxRetries !== undefined
      ? { agentMaxRetries: overrides.agentMaxRetries }
      : {}),
  })
  const noopSub: SubWorkflowRunner = async () => null
  return { ctx, events, hooks: makeHooks(ctx, noopSub) }
}

test('agent returns text result and counts', async () => {
  const { ctx, hooks } = buildCtx({
    agentResults: new Map([
      ['hi', { kind: 'ok', output: 'hello', usage: { outputTokens: 5 } }],
    ]),
  })
  const out = await hooks.agent('hi')
  expect(out).toBe('hello')
  expect(ctx.resources.agentCountBox.value).toBe(1)
})

test('agent skipped → null and not counted', async () => {
  const { hooks } = buildCtx({
    agentResults: new Map([['hi', { kind: 'skipped' }]]),
  })
  expect(await hooks.agent('hi')).toBeNull()
})

test('agent dead → null', async () => {
  const { hooks } = buildCtx({
    agentResults: new Map([['hi', { kind: 'dead' }]]),
  })
  expect(await hooks.agent('hi')).toBeNull()
})

// Retry: dead or non-abort throw both get one retry chance; WorkflowAbortedError (kill) is not retried.
// Retry still fails: dead stays dead; throw degrades to dead (does not break the workflow, hooks.agent returns null).
test('agent dead → retry once succeeds → ok', async () => {
  let calls = 0
  const { hooks } = buildCtx({
    runner: async () => {
      calls++
      return calls === 1
        ? { kind: 'dead' as const }
        : {
            kind: 'ok' as const,
            output: 'recovered',
            usage: { outputTokens: 5 },
          }
    },
  })
  expect(await hooks.agent('p')).toBe('recovered')
  expect(calls).toBe(2)
})

test('agent dead → every retry dead → final null (dead stays dead)', async () => {
  let calls = 0
  const warns: string[] = []
  const { hooks } = buildCtx({
    runner: async () => {
      calls++
      return { kind: 'dead' as const }
    },
    loggerWarn: msg => warns.push(msg),
  })
  expect(await hooks.agent('p')).toBeNull()
  // first attempt + AGENT_MAX_RETRIES
  expect(calls).toBe(1 + AGENT_MAX_RETRIES)
  expect(warns.at(-1)).toMatch(
    new RegExp(
      `no retries left \\(${AGENT_MAX_RETRIES}/${AGENT_MAX_RETRIES}\\)`,
    ),
  )
})

test('agent non-abort throw → retry once succeeds → ok', async () => {
  let calls = 0
  const { hooks } = buildCtx({
    runner: async () => {
      calls++
      if (calls === 1) throw new Error('transient network')
      return {
        kind: 'ok' as const,
        output: 'recovered',
        usage: { outputTokens: 3 },
      }
    },
    loggerWarn: () => {},
  })
  expect(await hooks.agent('p')).toBe('recovered')
  expect(calls).toBe(2)
})

test('agent non-abort throw → every retry throws → degrade to dead (returns null, does not break workflow)', async () => {
  let calls = 0
  const { hooks } = buildCtx({
    runner: async () => {
      calls++
      throw new Error('persistent')
    },
    loggerWarn: () => {},
  })
  expect(await hooks.agent('p')).toBeNull()
  expect(calls).toBe(1 + AGENT_MAX_RETRIES)
})

test('agent throw WorkflowAbortedError → no retry, rethrow directly (kill does not allow retry)', async () => {
  let calls = 0
  const { hooks } = buildCtx({
    runner: async () => {
      calls++
      throw new WorkflowAbortedError()
    },
  })
  await expect(hooks.agent('p')).rejects.toBeInstanceOf(WorkflowAbortedError)
  expect(calls).toBe(1)
})

test('agent ok → no retry (calls=1, saves a backend round-trip)', async () => {
  let calls = 0
  const { hooks } = buildCtx({
    runner: async () => {
      calls++
      return {
        kind: 'ok' as const,
        output: 'first-try',
        usage: { outputTokens: 1 },
      }
    },
  })
  expect(await hooks.agent('p')).toBe('first-try')
  expect(calls).toBe(1)
})

test('agent skipped → no retry (user actively skips, no retry)', async () => {
  let calls = 0
  const { hooks } = buildCtx({
    runner: async () => {
      calls++
      return { kind: 'skipped' as const }
    },
  })
  expect(await hooks.agent('p')).toBeNull()
  expect(calls).toBe(1)
})

test('agent journal hit does not call runner', async () => {
  let called = 0
  const { emitter } = createBufferingEmitter()
  const ports: WorkflowPorts = {
    agentRunner: {
      runAgentToResult: async () => {
        called++
        return { kind: 'ok', output: 'live', usage: { outputTokens: 1 } }
      },
    },
    progressEmitter: emitter,
    taskRegistrar: {
      register: () => ({ runId: 'r', signal: new AbortController().signal }),
      complete: () => {},
      fail: () => {},
      kill: () => {},
      pendingAction: () => null,
    },
    journalStore: {
      read: async () => [],
      append: async () => {},
      truncate: async () => {},
    },
    permissionGate: { isAborted: () => false },
    logger: { debug: () => {}, event: () => {} },
    hostFactory: () => ({
      handle: createHostHandle(null),
      cwd: '/tmp',
      budgetTotal: null,
    }),
  }
  const key = agentCallKey('hi', { prompt: 'hi' })
  const ctx = createEngineContext({
    ports,
    host: createHostHandle(null),
    signal: new AbortController().signal,
    runId: 'r1',
    workflowName: 'w',
    cwd: '/tmp',
    budgetTotal: null,
    journal: [
      {
        key,
        seq: 0,
        result: { kind: 'ok', output: 'cached', usage: { outputTokens: 1 } },
      },
    ],
  })
  const hooks = makeHooks(ctx, async () => null)
  expect(await hooks.agent('hi')).toBe('cached')
  expect(called).toBe(0)
})

test('checkpoint resume safely replays a legacy OCC journal entry and migrates the next live entry to v2', async () => {
  let calls = 0
  const appended: JournalEntry[] = []
  const first = 'legacy-first'
  const { hooks } = buildCtx({
    journal: [
      {
        key: legacyOccAgentCallKey(first, { prompt: first }),
        seq: 0,
        result: {
          kind: 'ok',
          output: 'cached:first',
          usage: { outputTokens: 1 },
        },
      },
    ],
    appended,
    runner: async params => {
      calls++
      return {
        kind: 'ok',
        output: `live:${params.prompt}`,
        usage: { outputTokens: 1 },
      }
    },
  })

  expect(await hooks.agent(first)).toBe('cached:first')
  expect(await hooks.agent('new-second')).toBe('live:new-second')
  expect(calls).toBe(1)
  expect(appended.map(entry => entry.key)).toEqual([
    agentCallKey(first, { prompt: first }),
    agentCallKey(
      'new-second',
      { prompt: 'new-second' },
      agentCallKey(first, { prompt: first }),
    ),
  ])
})

test('checkpoint resume audits but does not replay a skipped journal call', async () => {
  let calls = 0
  const prompt = 'skipped-before'
  const { hooks, events } = buildCtx({
    journal: checkpointJournal([prompt], () => ({ kind: 'skipped' })),
    runner: async () => {
      calls++
      return { kind: 'ok', output: 'live', usage: { outputTokens: 1 } }
    },
  })

  expect(await hooks.agent(prompt)).toBe('live')
  expect(calls).toBe(1)
  const done = events.find(event => event.type === 'agent_done')
  expect(done?.type === 'agent_done' ? done.execution : undefined).toBe('live')
})

test('resume policy all reruns every completed call and reports live execution', async () => {
  const prompts: string[] = []
  const journal = checkpointJournal(['a', 'b'], prompt => ({
    kind: 'ok',
    output: `cached:${prompt}`,
    usage: { outputTokens: 1 },
  }))
  const { hooks, events } = buildCtx({
    journal,
    resumePolicy: { scope: 'all' },
    runner: async params => {
      prompts.push(params.prompt)
      return {
        kind: 'ok',
        output: `live:${params.prompt}`,
        usage: { outputTokens: 1 },
      }
    },
  })

  expect(await hooks.agent('a')).toBe('live:a')
  expect(await hooks.agent('b')).toBe('live:b')
  expect(prompts).toEqual(['a', 'b'])
  expect(
    events
      .filter(event => event.type === 'agent_done')
      .map(event => event.execution),
  ).toEqual(['live', 'live'])
})

test.each([
  [{ scope: 'range', fromAgentId: 1, toAgentId: 2 } as const, [1, 2]],
  [{ scope: 'agents', agentIds: [0, 2] } as ResumePolicy, [0, 2]],
])('selective resume reruns only selected completed calls: %o', async (policy, selected) => {
  const liveIds: number[] = []
  const journal = checkpointJournal(['a', 'b', 'c'], prompt => ({
    kind: 'ok',
    output: `same:${prompt}`,
    usage: { outputTokens: 1 },
  }))
  const { hooks, events } = buildCtx({
    journal,
    resumePolicy: policy,
    runner: async params => {
      liveIds.push(['a', 'b', 'c'].indexOf(params.prompt))
      return {
        kind: 'ok',
        output: `same:${params.prompt}`,
        usage: { outputTokens: 1 },
      }
    },
  })

  await hooks.agent('a')
  await hooks.agent('b')
  await hooks.agent('c')
  expect(liveIds).toEqual(selected)
  expect(
    events
      .filter(event => event.type === 'agent_done')
      .map(event => event.execution),
  ).toEqual([0, 1, 2].map(id => (selected.includes(id) ? 'live' : 'replayed')))
})

test('parallel resume decisions wait for selected output before replaying a later checkpoint', async () => {
  const live: string[] = []
  const journal = checkpointJournal(['a', 'b'], prompt => ({
    kind: 'ok',
    output: prompt === 'a' ? 'old:a' : 'cached:b',
    usage: { outputTokens: 1 },
  }))
  const { hooks } = buildCtx({
    journal,
    resumePolicy: { scope: 'agents', agentIds: [0] },
    runner: async params => {
      live.push(params.prompt)
      if (params.prompt === 'a') {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      return {
        kind: 'ok',
        output: `live:${params.prompt}`,
        usage: { outputTokens: 1 },
      }
    },
  })

  expect(
    await hooks.parallel([() => hooks.agent('a'), () => hooks.agent('b')]),
  ).toEqual(['live:a', 'live:b'])
  expect(live).toEqual(['a', 'b'])
})

test('checkpoint replays only the longest matching prefix after post-processing code changes', async () => {
  const journal = checkpointJournal(
    ['fetch', 'summarize-old', 'publish'],
    prompt => ({
      kind: 'ok',
      output: `cached:${prompt}`,
      usage: { outputTokens: 1 },
    }),
  )
  const live: string[] = []
  const { hooks } = buildCtx({
    journal,
    runner: async params => {
      live.push(params.prompt)
      return {
        kind: 'ok',
        output: `live:${params.prompt}`,
        usage: { outputTokens: 1 },
      }
    },
  })

  expect(await hooks.agent('fetch')).toBe('cached:fetch')
  expect(await hooks.agent('summarize-new')).toBe('live:summarize-new')
  expect(await hooks.agent('publish')).toBe('live:publish')
  expect(live).toEqual(['summarize-new', 'publish'])
})

test('parallel chained checkpoints keep invocation order while live backends overlap', async () => {
  const journal = checkpointJournal(['a', 'b', 'c'], prompt => ({
    kind: 'ok',
    output: `cached:${prompt}`,
    usage: { outputTokens: 1 },
  }))
  const starts: string[] = []
  let releaseA = (): void => {}
  const waitForA = new Promise<void>(resolve => {
    releaseA = resolve
  })
  const { hooks } = buildCtx({
    journal,
    resumePolicy: { scope: 'agents', agentIds: [0, 1] },
    runner: async params => {
      starts.push(params.prompt)
      if (params.prompt === 'a') await waitForA
      if (params.prompt === 'b') releaseA()
      return {
        kind: 'ok',
        output: `cached:${params.prompt}`,
        usage: { outputTokens: 1 },
      }
    },
  })

  expect(
    await hooks.parallel([
      () => hooks.agent('a'),
      () => hooks.agent('b'),
      () => hooks.agent('c'),
    ]),
  ).toEqual(['cached:a', 'cached:b', 'cached:c'])
  expect(starts).toEqual(['a', 'b'])
})

test('journal match requires both global seq and key', async () => {
  let calls = 0
  const prompt = 'same-key'
  const { hooks } = buildCtx({
    journal: [
      {
        key: agentCallKey(prompt, { prompt }),
        seq: 1,
        result: {
          kind: 'ok',
          output: 'wrong-seq-cache',
          usage: { outputTokens: 1 },
        },
      },
    ],
    runner: async () => {
      calls++
      return { kind: 'ok', output: 'live', usage: { outputTokens: 1 } }
    },
  })

  expect(await hooks.agent(prompt)).toBe('live')
  expect(calls).toBe(1)
})

test('incomplete call reruns and conservatively closes over the cached suffix', async () => {
  const live: string[] = []
  const { hooks } = buildCtx({
    journal: [
      {
        key: agentCallKey('b', { prompt: 'b' }),
        seq: 1,
        result: {
          kind: 'ok',
          output: 'cached:b',
          usage: { outputTokens: 1 },
        },
      },
    ],
    runner: async params => {
      live.push(params.prompt)
      return {
        kind: 'ok',
        output: `live:${params.prompt}`,
        usage: { outputTokens: 1 },
      }
    },
  })

  expect(await hooks.agent('a')).toBe('live:a')
  expect(await hooks.agent('b')).toBe('live:b')
  expect(live).toEqual(['a', 'b'])
})

test('agent exceeding total cap throws', async () => {
  const { hooks, ctx } = buildCtx()
  ctx.resources.agentCountBox.value = 1000
  await expect(hooks.agent('hi')).rejects.toThrow(WorkflowError)
})

test('parallel single item throws → null, others kept', async () => {
  const { hooks } = buildCtx()
  const out = await hooks.parallel([
    async () => 'a',
    async () => {
      throw new Error('x')
    },
    async () => 'c',
  ])
  expect(out).toEqual(['a', null, 'c'])
})

test('parallel single item throws → logger.warn records the failure reason', async () => {
  const warns: string[] = []
  const { hooks } = buildCtx({ loggerWarn: msg => warns.push(msg) })
  await hooks.parallel([
    async () => 'a',
    async () => {
      throw new Error('boom-x')
    },
    async () => 'c',
  ])
  expect(warns.length).toBe(1)
  expect(warns[0]).toMatch(/boom-x/)
})

test('pipeline chains stage by stage, stage throws → null', async () => {
  const { hooks } = buildCtx()
  const out = await hooks.pipeline(
    [1, 2],
    n => Promise.resolve((n as number) + 1),
    m => Promise.resolve((m as number) * 10),
  )
  expect(out).toEqual([20, 30])
  const out2 = await hooks.pipeline(
    [1],
    () => Promise.reject(new Error('boom')),
    m => Promise.resolve(m),
  )
  expect(out2).toEqual([null])
})

test('pipeline stage throws → logger.warn records the failure reason', async () => {
  const warns: string[] = []
  const { hooks } = buildCtx({ loggerWarn: msg => warns.push(msg) })
  await hooks.pipeline(
    [1],
    () => Promise.reject(new Error('stage-boom')),
    m => Promise.resolve(m),
  )
  expect(warns.length).toBe(1)
  expect(warns[0]).toMatch(/stage-boom/)
})

test('pipeline over 4096 throws', async () => {
  const { hooks } = buildCtx()
  await expect(
    hooks.pipeline(Array(4097), () => Promise.resolve(1)),
  ).rejects.toThrow(WorkflowError)
})

test('phase switch emits phase_started/done; log emits log', () => {
  const { hooks, events } = buildCtx()
  hooks.phase('A')
  hooks.log('hello')
  hooks.phase('B')
  expect(events.some(e => e.type === 'phase_started' && e.phase === 'A')).toBe(
    true,
  )
  expect(events.some(e => e.type === 'phase_done' && e.phase === 'A')).toBe(
    true,
  )
  expect(events.some(e => e.type === 'log' && e.message === 'hello')).toBe(true)
  expect(events.some(e => e.type === 'phase_started' && e.phase === 'B')).toBe(
    true,
  )
})

// ---- boundary and error paths ----

test('agent dead also counts in agentCountBox', async () => {
  const { hooks, ctx } = buildCtx({
    agentResults: new Map([['x', { kind: 'dead' }]]),
  })
  await hooks.agent('x')
  expect(ctx.resources.agentCountBox.value).toBe(1)
})

test('agent pendingAction=skip → null, does not call runner, not counted', async () => {
  let called = 0
  const { hooks, ctx } = buildCtx({
    pending: { kind: 'skip' },
    runner: async () => {
      called++
      return { kind: 'ok', output: 'x', usage: { outputTokens: 1 } }
    },
  })
  expect(await hooks.agent('x')).toBeNull()
  expect(called).toBe(0)
  expect(ctx.resources.agentCountBox.value).toBe(0)
})

test('agent journal identity diverges → marks suffix for authoritative rewrite', async () => {
  const truncated: string[] = []
  const { hooks, ctx } = buildCtx({
    runner: async () => ({
      kind: 'ok',
      output: 'live',
      usage: { outputTokens: 1 },
    }),
    journal: [
      {
        key: 'stale-key',
        seq: 0,
        result: { kind: 'ok', output: 'old', usage: { outputTokens: 1 } },
      },
    ],
    truncated,
  })
  const out = await hooks.agent('different-prompt')
  expect(out).toBe('live')
  expect(truncated).toEqual([])
  expect(ctx.journalInvalidated).toBe(true)
  expect(ctx.resumeState?.journalNeedsRewrite).toBe(true)
  expect(ctx.resumeState?.divergentFrom).toBe(0)
})

test('agent journal divergence retains the valid prefix and appends the live suffix at the same seq', async () => {
  const rewritten: Array<{ runId: string; entries: JournalEntry[] }> = []
  const appended: JournalEntry[] = []
  const firstPrompt = 'cached-first'
  const firstKey = agentCallKey(firstPrompt, { prompt: firstPrompt })
  const staleSecondKey = agentCallKey(
    'stale-second',
    { prompt: 'stale-second' },
    firstKey,
  )
  const { hooks, ctx } = buildCtx({
    runner: async params => ({
      kind: 'ok',
      output: `live:${params.prompt}`,
      usage: { outputTokens: 1 },
    }),
    journal: [
      {
        key: firstKey,
        seq: 0,
        result: {
          kind: 'ok',
          output: 'cached:first',
          usage: { outputTokens: 1 },
        },
      },
      {
        key: staleSecondKey,
        seq: 1,
        result: {
          kind: 'ok',
          output: 'cached:stale',
          usage: { outputTokens: 1 },
        },
      },
    ],
    rewritten,
    appended,
  })

  expect(await hooks.agent(firstPrompt)).toBe('cached:first')
  expect(await hooks.agent('changed-second')).toBe('live:changed-second')

  // Hooks defer the atomic rewrite until the attempt finishes, avoiding rewrite/append
  // races between parallel calls. The run engine persists exactly this reached prefix.
  expect(rewritten).toEqual([])
  expect(ctx.resumeState?.journalNeedsRewrite).toBe(true)
  expect(
    [...(ctx.resumeState?.reachedEntries.values() ?? [])].map(
      entry => entry.key,
    ),
  ).toEqual([firstKey, appended[0]!.key])
  expect(appended).toHaveLength(1)
  expect(appended[0]!.seq).toBe(1)
})

test('agent throws when budget exhausted', async () => {
  const { hooks, ctx } = buildCtx({
    budgetTotal: 10,
    runner: async () => ({
      kind: 'ok',
      output: 'x',
      usage: { outputTokens: 1 },
    }),
  })
  ctx.resources.budget.addOutputTokens(10)
  await expect(hooks.agent('x')).rejects.toThrow()
})

test('agent budget check inside semaphore critical section (queued waiter sees latest spent)', async () => {
  // When semaphore capacity < parallel agent count, some agents will queue.
  // Old bug: assertCanSpend was before acquire, all waiters entered the queue with spent=0 and passed the check;
  // after permits released waiters ran the runner and deducted the budget without re-checking → all over-spent.
  // Fix: assertCanSpend moved into the critical section; waiters check spent after being woken before deciding to run.
  // Force capacity=1 (serializing semaphore) to ensure N>1 agents must queue.
  const { hooks, ctx } = buildCtx({
    budgetTotal: 10,
    runner: async () => {
      // make the runner a bit slow to ensure waiters truly queue
      await new Promise(r => {
        setTimeout(r, 5)
      })
      return {
        kind: 'ok',
        output: 'x',
        usage: { outputTokens: 6 }, // 6 tokens each, 2 runs exceed 10
      }
    },
  })
  // replace the default semaphore with a single-permit one, forcing serialization
  ctx.resources.semaphore = new Semaphore(1)
  const results = await hooks.parallel([
    () => hooks.agent('a'),
    () => hooks.agent('b'),
    () => hooks.agent('c'),
    () => hooks.agent('d'),
  ])
  // at least 1 agent is caught as null by parallel (assertCanSpend throws)
  expect(results.some(r => r === null)).toBe(true)
  // not all 4 should run and spend 24; the cap is at-most-one-over (first two spend 12, last two blocked)
  expect(ctx.resources.budget.spent()).toBeLessThanOrEqual(12)
})

test('agent signal aborted → WorkflowAbortedError', async () => {
  const ac = new AbortController()
  ac.abort()
  const { hooks } = buildCtx({
    signal: ac.signal,
    runner: async () => ({
      kind: 'ok',
      output: 'x',
      usage: { outputTokens: 1 },
    }),
  })
  await expect(hooks.agent('x')).rejects.toThrow(WorkflowAbortedError)
})

test('parallel over 4096 items throws', async () => {
  const { hooks } = buildCtx()
  await expect(
    hooks.parallel(Array.from({ length: 4097 }, () => async () => 1)),
  ).rejects.toThrow(WorkflowError)
})

test('workflow() nesting beyond one level throws', async () => {
  const { hooks, ctx } = buildCtx()
  ctx.resources.depth = 1
  await expect(hooks.workflow('child')).rejects.toThrow(WorkflowError)
})

test('agent concurrency bounded by semaphore (does not exceed maxConcurrency)', async () => {
  let active = 0
  let peak = 0
  const { hooks } = buildCtx({
    runner: async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(r => {
        setTimeout(r, 5)
      })
      active--
      return { kind: 'ok', output: 'x', usage: { outputTokens: 1 } }
    },
  })
  await hooks.parallel(Array.from({ length: 32 }, () => () => hooks.agent('p')))
  expect(peak).toBeLessThanOrEqual(maxConcurrency())
})

test('agentAdapterRegistry takes priority over agentRunner (dispatched to adapter by route)', async () => {
  const called: string[] = []
  const registry = new AgentAdapterRegistry()
    .register({
      id: 'ad',
      capabilities: { structuredOutput: true },
      async run() {
        called.push('adapter')
        return {
          kind: 'ok',
          output: 'from-adapter',
          usage: { outputTokens: 1 },
        }
      },
    })
    .default('ad')
  const { hooks } = buildCtx({
    agentAdapterRegistry: registry,
    runner: async () => {
      called.push('runner')
      return { kind: 'ok', output: 'from-runner', usage: { outputTokens: 1 } }
    },
  })
  expect(await hooks.agent('x')).toBe('from-adapter')
  expect(called).toEqual(['adapter'])
})

test('agentAdapterRegistry resolve throws → agent rethrows (workflow failed)', async () => {
  const registry = new AgentAdapterRegistry().default('missing') // not registered
  const { hooks } = buildCtx({
    agentAdapterRegistry: registry,
    runner: async () => ({
      kind: 'ok',
      output: 'x',
      usage: { outputTokens: 1 },
    }),
  })
  await expect(hooks.agent('x')).rejects.toThrow()
})

// service.kill(runId, agentId) bridge: hooks.agent must inject taskRegistrar's
// registerAgentAbort/unregisterAgentAbort into adapterCtx (bound to the current runId).
// The backend puts the agentAbort controller into a Map based on this; service.kill aborts precisely by agentId.
test('agentAdapter ctx injects registerAgentAbort/unregisterAgentAbort (bound to runId, forwards to taskRegistrar)', async () => {
  const registered: Array<{
    runId: string
    agentId: number
    controller: AbortController
  }> = []
  const unregistered: Array<{ runId: string; agentId: number }> = []
  // capture the ctx hooks pass to the adapter (verify register/unregister are injected and bound to runId)
  let capturedCtx: {
    registerAgentAbort?: (id: number, ac: AbortController) => void
    unregisterAgentAbort?: (id: number) => void
    agentId: number
    runId: string
  } | null = null
  const registry = new AgentAdapterRegistry()
    .register({
      id: 'ad',
      capabilities: { structuredOutput: true },
      async run(_params, ctx) {
        capturedCtx = ctx
        return { kind: 'ok', output: 'x', usage: { outputTokens: 1 } }
      },
    })
    .default('ad')
  const { hooks } = buildCtx({
    agentAdapterRegistry: registry,
    registerAgentAbort: (runId, agentId, controller) =>
      registered.push({ runId, agentId, controller }),
    unregisterAgentAbort: (runId, agentId) =>
      unregistered.push({ runId, agentId }),
  })
  await hooks.agent('x')
  // ctx contains register/unregister (closure bound to runId='r1')
  expect(capturedCtx).not.toBeNull()
  expect(typeof capturedCtx!.registerAgentAbort).toBe('function')
  expect(typeof capturedCtx!.unregisterAgentAbort).toBe('function')
  // simulate backend call: the injected closure forwards (agentId, controller) to taskRegistrar,
  // and auto-fills runId='r1' (backend does not need to know runId)
  const ac = new AbortController()
  capturedCtx!.registerAgentAbort!(7, ac)
  capturedCtx!.unregisterAgentAbort!(7)
  expect(registered).toEqual([{ runId: 'r1', agentId: 7, controller: ac }])
  expect(unregistered).toEqual([{ runId: 'r1', agentId: 7 }])
})

// ---- retry classification and journal resume-retry ----

test('agent dead retryable:false → no in-place retry (deterministic failure, e.g. prompt-too-long)', async () => {
  let calls = 0
  const warns: string[] = []
  const { hooks } = buildCtx({
    runner: async () => {
      calls++
      return {
        kind: 'dead' as const,
        reason: 'prompt-too-long' as const,
        retryable: false,
      }
    },
    loggerWarn: msg => warns.push(msg),
  })
  expect(await hooks.agent('p')).toBeNull()
  expect(calls).toBe(1)
  expect(warns[0]).toMatch(/not retrying/)
})

test('agent dead retryable:true → still retried once (explicit transient)', async () => {
  let calls = 0
  const { hooks } = buildCtx({
    runner: async () => {
      calls++
      return calls === 1
        ? {
            kind: 'dead' as const,
            reason: 'api-error' as const,
            retryable: true,
          }
        : {
            kind: 'ok' as const,
            output: 'recovered',
            usage: { outputTokens: 1 },
          }
    },
    loggerWarn: () => {},
  })
  expect(await hooks.agent('p')).toBe('recovered')
  expect(calls).toBe(2)
})

test('journal dead entry recovery invalidates and reruns the divergent suffix', async () => {
  const keyA = agentCallKey('a', { prompt: 'a' })
  const keyB = agentCallKey('b', { prompt: 'b' }, keyA)
  let calls = 0
  const appended: JournalEntry[] = []
  const { hooks, ctx } = buildCtx({
    runner: async () => {
      calls++
      return {
        kind: 'ok' as const,
        output: 'fresh',
        usage: { outputTokens: 1 },
      }
    },
    journal: [
      { key: keyA, seq: 0, result: { kind: 'dead', reason: 'api-error' } },
      {
        key: keyB,
        seq: 1,
        result: { kind: 'ok', output: 'cached-b', usage: { outputTokens: 1 } },
      },
    ],
    appended,
  })
  // The dead baseline produced null. Recovering to a value can alter every downstream
  // prompt/control branch, so the suffix must run live rather than replay stale output.
  expect(await hooks.agent('a')).toBe('fresh')
  expect(calls).toBe(1)
  expect(await hooks.agent('b')).toBe('fresh')
  expect(calls).toBe(2)
  expect(ctx.journalInvalidated).toBe(true)
  // Every live replacement keeps the original global seq.
  expect(appended.map(entry => entry.seq)).toEqual([0, 1])
  expect(appended.every(entry => entry.result.kind === 'ok')).toBe(true)
})

// ---- retry loop: budget, observability, and the journal/budget invariants ----

test('agent dead → recovers on the last allowed retry (1 + AGENT_MAX_RETRIES attempts)', async () => {
  let calls = 0
  const { hooks } = buildCtx({
    runner: async () => {
      calls++
      return calls <= AGENT_MAX_RETRIES
        ? { kind: 'dead' as const, reason: 'api-error' as const }
        : {
            kind: 'ok' as const,
            output: 'recovered',
            usage: { outputTokens: 7 },
          }
    },
    loggerWarn: () => {},
  })
  expect(await hooks.agent('p')).toBe('recovered')
  expect(calls).toBe(1 + AGENT_MAX_RETRIES)
})

test('agentMaxRetries:0 disables the in-place retry entirely', async () => {
  let calls = 0
  const { hooks } = buildCtx({
    agentMaxRetries: 0,
    runner: async () => {
      calls++
      return { kind: 'dead' as const, reason: 'api-error' as const }
    },
    loggerWarn: () => {},
  })
  expect(await hooks.agent('p')).toBeNull()
  expect(calls).toBe(1)
})

test('no-structured-output gets the reduced per-cause retry budget, not AGENT_MAX_RETRIES', async () => {
  // Its retry unit is a whole agent run that already spent its tokens, so it is capped
  // below the generic budget (AGENT_MAX_RETRIES_BY_REASON).
  let calls = 0
  const { hooks } = buildCtx({
    runner: async () => {
      calls++
      return { kind: 'dead' as const, reason: 'no-structured-output' as const }
    },
    loggerWarn: () => {},
  })
  expect(await hooks.agent('p')).toBeNull()
  expect(calls).toBe(1 + AGENT_MAX_RETRIES_BY_REASON['no-structured-output']!)
  expect(calls).toBeLessThan(1 + AGENT_MAX_RETRIES)
})

test('in-place retry emits agent_retry, never a second agent_started', async () => {
  // A repeated agent_started makes store.ts restart the row and reset startedAt, so an
  // agent 14s into its third attempt renders as "just started" — worse than silence.
  // agent_retry keeps the row alive and records the attempt instead.
  let calls = 0
  const { hooks, events } = buildCtx({
    runner: async () => {
      calls++
      return calls <= 2
        ? { kind: 'dead' as const, reason: 'api-error' as const }
        : { kind: 'ok' as const, output: 'ok-3', usage: { outputTokens: 2 } }
    },
    loggerWarn: () => {},
  })
  expect(await hooks.agent('p', { label: 'worker' })).toBe('ok-3')

  expect(events.map(e => e.type)).toEqual([
    'agent_started',
    'agent_retry',
    'agent_retry',
    'agent_done',
  ])
  const retries = events.filter(e => e.type === 'agent_retry')
  expect(retries.map(e => (e.type === 'agent_retry' ? e.attempt : -1))).toEqual(
    [1, 2],
  )
  for (const e of retries) {
    if (e.type !== 'agent_retry') continue
    expect(e.agentId).toBe(0) // same row as the single agent_started
    expect(e.label).toBe('worker')
    expect(e.limit).toBe(AGENT_MAX_RETRIES)
    expect(e.reason).toBe('api-error')
    expect(e.runId).toBe('r1')
  }
})

test('a throw-triggered retry reports reason "threw" with the message as detail', async () => {
  let calls = 0
  const { hooks, events } = buildCtx({
    runner: async () => {
      calls++
      if (calls === 1) throw new Error('socket hang up')
      return { kind: 'ok' as const, output: 'ok', usage: { outputTokens: 1 } }
    },
    loggerWarn: () => {},
  })
  await hooks.agent('p')
  const retry = events.find(e => e.type === 'agent_retry')
  expect(retry).toBeDefined()
  if (retry?.type !== 'agent_retry') throw new Error('unreachable')
  expect(retry.reason).toBe('threw')
  expect(retry.detail).toContain('socket hang up')
})

test('agent_retry carries the delay the engine is about to wait (panel can show the backoff)', async () => {
  let calls = 0
  const { hooks, events } = buildCtx({
    retryBackoffMs: 100,
    runner: async () => {
      calls++
      return calls === 1
        ? { kind: 'dead' as const, reason: 'api-error' as const }
        : { kind: 'ok' as const, output: 'ok', usage: { outputTokens: 1 } }
    },
    loggerWarn: () => {},
  })
  await hooks.agent('p')
  const retry = events.find(e => e.type === 'agent_retry')
  if (retry?.type !== 'agent_retry') throw new Error('unreachable')
  // retry #1 → base * 2^0, plus at most the jitter ratio
  expect(retry.delayMs).toBeGreaterThanOrEqual(100)
  expect(retry.delayMs).toBeLessThanOrEqual(125)
})

test('a transient worktree-failed is retried once, not three times', async () => {
  // The backend marks git lock contention retryable (a sibling agent held the index/ref
  // lock) and everything else on that path retryable:false. The transient case still gets
  // the narrow per-cause budget: a lock clears within one backoff or not at all.
  let calls = 0
  const { hooks } = buildCtx({
    runner: async () => {
      calls++
      return { kind: 'dead' as const, reason: 'worktree-failed' as const }
    },
    loggerWarn: () => {},
  })
  expect(await hooks.agent('p')).toBeNull()
  expect(calls).toBe(1 + AGENT_MAX_RETRIES_BY_REASON['worktree-failed']!)
  expect(calls).toBe(2)
})

test('retryable:false emits no agent_retry at all', async () => {
  const { hooks, events } = buildCtx({
    runner: async () => ({
      kind: 'dead' as const,
      reason: 'worktree-failed' as const,
      retryable: false,
    }),
    loggerWarn: () => {},
  })
  await hooks.agent('p')
  expect(events.some(e => e.type === 'agent_retry')).toBe(false)
  expect(events.filter(e => e.type === 'agent_started')).toHaveLength(1)
})

test('retry does not double-charge budget nor append intermediate journal entries', async () => {
  const appended: JournalEntry[] = []
  let calls = 0
  const { hooks, ctx, events } = buildCtx({
    appended,
    runner: async () => {
      calls++
      return calls <= 2
        ? { kind: 'dead' as const, reason: 'api-error' as const }
        : { kind: 'ok' as const, output: 'final', usage: { outputTokens: 11 } }
    },
    loggerWarn: () => {},
  })
  expect(await hooks.agent('p')).toBe('final')
  // one journal record, holding the final result only — a mid-retry append would make the
  // next resume replay a failure that never was the outcome
  expect(appended).toHaveLength(1)
  expect(appended[0]!.result.kind).toBe('ok')
  expect(ctx.journal).toHaveLength(1)
  // dead never charges; the surviving ok charges exactly once
  expect(ctx.resources.budget.spent()).toBe(11)
  expect(events.filter(e => e.type === 'agent_done')).toHaveLength(1)
})

test('retries reuse the identical params, so the journal key is unchanged (resume stays aligned)', async () => {
  const appended: JournalEntry[] = []
  const seen: AgentRunParams[] = []
  let calls = 0
  const { hooks } = buildCtx({
    appended,
    runner: async params => {
      seen.push(params)
      calls++
      return calls === 1
        ? { kind: 'dead' as const, reason: 'api-error' as const }
        : { kind: 'ok' as const, output: 'v', usage: { outputTokens: 1 } }
    },
    loggerWarn: () => {},
  })
  await hooks.agent('p', { label: 'L', model: 'haiku' })
  expect(seen).toHaveLength(2)
  expect(seen[1]).toEqual(seen[0]!)
  // key must equal the one a fresh replay computes for the same call
  expect(appended[0]!.key).toBe(
    agentCallKey('p', { prompt: 'p', label: 'L', model: 'haiku' }),
  )
})

test('abort during the retry backoff stops the loop with WorkflowAbortedError (no further attempt)', async () => {
  const ac = new AbortController()
  let calls = 0
  const { hooks } = buildCtx({
    signal: ac.signal,
    retryBackoffMs: 5_000, // long enough that only the abort can end the wait
    runner: async () => {
      calls++
      setTimeout(() => ac.abort(), 5)
      return { kind: 'dead' as const, reason: 'api-error' as const }
    },
    loggerWarn: () => {},
  })
  const started = Date.now()
  await expect(hooks.agent('p')).rejects.toBeInstanceOf(WorkflowAbortedError)
  // the wait is abort-aware: it must not sit out the full backoff
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(calls).toBe(1)
})

test('an already-aborted signal is not retried even when the failure looks transient', async () => {
  const ac = new AbortController()
  let calls = 0
  const { hooks } = buildCtx({
    signal: ac.signal,
    runner: async () => {
      calls++
      ac.abort()
      throw new Error('socket closed')
    },
    loggerWarn: () => {},
  })
  await expect(hooks.agent('p')).rejects.toBeInstanceOf(WorkflowAbortedError)
  expect(calls).toBe(1)
})

test('parallel rethrows WorkflowAbortedError (kill must end the run, not degrade to null)', async () => {
  const { hooks } = buildCtx()
  await expect(
    hooks.parallel([
      async () => 'a',
      async () => {
        throw new WorkflowAbortedError()
      },
    ]),
  ).rejects.toBeInstanceOf(WorkflowAbortedError)
})

test('pipeline rethrows WorkflowAbortedError', async () => {
  const { hooks } = buildCtx()
  await expect(
    hooks.pipeline([1], () => Promise.reject(new WorkflowAbortedError())),
  ).rejects.toBeInstanceOf(WorkflowAbortedError)
})

test('taskRegistrar does not provide registerAgentAbort → adapterCtx also lacks it (hooks do not error)', async () => {
  // without registerAgentAbort/unregisterAgentAbort overrides → buildCtx does not inject taskRegistrar either
  // hooks skip via optional chaining; adapterCtx lacks these two fields
  let capturedCtx: object | null = null
  const registry = new AgentAdapterRegistry()
    .register({
      id: 'ad',
      capabilities: { structuredOutput: true },
      async run(_params, ctx) {
        capturedCtx = ctx
        return { kind: 'ok', output: 'x', usage: { outputTokens: 1 } }
      },
    })
    .default('ad')
  const { hooks } = buildCtx({ agentAdapterRegistry: registry })
  await hooks.agent('x')
  expect(capturedCtx).not.toBeNull()
  expect(
    (capturedCtx! as Record<string, unknown>).registerAgentAbort,
  ).toBeUndefined()
})

test('agent journal divergence is reported, not silent', async () => {
  // A resume that discards its checkpoints looks exactly like one that replayed
  // them — same tool result, same run id — and the only symptom is paying for a
  // full fresh fan-out again. It has to announce itself.
  const warnings: string[] = []
  const { hooks, events } = buildCtx({
    runner: async () => ({
      kind: 'ok',
      output: 'live',
      usage: { outputTokens: 1 },
    }),
    journal: [
      {
        key: 'stale-key',
        seq: 0,
        result: { kind: 'ok', output: 'old', usage: { outputTokens: 1 } },
      },
      {
        key: 'another-stale-key',
        seq: 1,
        result: { kind: 'ok', output: 'old2', usage: { outputTokens: 1 } },
      },
    ],
    loggerWarn: (msg: string) => void warnings.push(msg),
  })

  await hooks.agent('a-prompt-that-was-never-recorded')

  expect(warnings.some(w => w.includes('diverged'))).toBe(true)
  const logEvents = events.filter(e => e.type === 'log')
  expect(logEvents.length).toBe(1)
  // Diverging at the very first call means nothing was reused. The id is reported
  // 0-based, matching the progress rows and the resumePolicy selectors — a 1-based
  // "call #N" left the user to translate before they could re-select the agent.
  expect((logEvents[0] as { message: string }).message).toContain(
    'agentId 0 (0-based)',
  )
  expect((logEvents[0] as { message: string }).message).toContain(
    '0 cached result(s) replayed',
  )
})
