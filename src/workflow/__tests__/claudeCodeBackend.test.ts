import { expect, test, mock } from 'bun:test'

// Note: mock specifier must resolve to the same module that impl actually imports (bun mock.module
// matches by resolved module). impl uses '@open-claude-code/builtin-tools/...' and 'src/*' alias
// path imports, so the same specifier is used here.
mock.module(
  '@open-claude-code/builtin-tools/tools/AgentTool/runAgent.js',
  () => ({
    runAgent: async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'agent-text' }] },
      }
    },
  }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/AgentTool/agentToolUtils.js',
  () => ({
    finalizeAgentTool: () => ({
      content: [{ type: 'text', text: 'agent-text' }],
      usage: { output_tokens: 42 },
      totalTokens: 42,
      totalToolUseCount: 3,
    }),
  }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js',
  () => ({
    isBuiltInAgent: () => true,
  }),
)
mock.module('src/tools.js', () => ({ assembleToolPool: () => ({ tools: [] }) }))
mock.module('src/utils/messages.js', () => ({
  // Return a shape that satisfies UserMessage consumers process-wide.
  // Bun's mock.module is process-global (last-write-wins), so an incomplete
  // mock here corrupts every later test that imports the real createUserMessage
  // (e.g. bridgeMessaging.test.ts's `type !== 'user'` early-exit, or
  // processSlashCommand.test.ts's `message.content` access). Mirror the real
  // shape from src/utils/messages.ts: type + message envelope + passthrough.
  createUserMessage: (
    o: {
      content: string
    } & Record<string, unknown>,
  ) => ({
    type: 'user' as const,
    message: { role: 'user', content: o.content },
    ...o,
  }),
  extractTextContent: () => 'agent-text',
}))
mock.module('src/utils/collections/uuid.js', () => ({
  createAgentId: () => 'agent-1',
}))
mock.module('src/services/analytics/index.js', () => ({ logEvent: () => {} }))
mock.module('src/utils/telemetry/debug.js', () => ({
  logForDebugging: () => {},
}))

// isolation:'worktree' tests: mock worktree trio (to avoid actually running git worktree add).
// Note mock.module is process-global; worktreeState is defined outside the factory for test reset.
// Do not mock cwd.js: runWithCwdOverride actually running AsyncLocalStorage is harmless to mocked runAgent,
// and avoids polluting other tests in the same process that depend on pwd/getCwd.
const worktreeState = {
  shouldThrow: false,
  /** Message createAgentWorktree throws with; drives the retryable classification. */
  throwMessage: 'wt boom',
  hasChanges: false,
  created: [] as string[],
  removed: [] as string[],
  changesCalls: 0,
}
mock.module('src/utils/git/worktree.js', () => ({
  createAgentWorktree: async (slug: string) => {
    if (worktreeState.shouldThrow) throw new Error(worktreeState.throwMessage)
    worktreeState.created.push(slug)
    return {
      worktreePath: '/fake/wt',
      worktreeBranch: 'wt-branch',
      headCommit: 'abc123',
      gitRoot: '/fake',
      hookBased: false,
    }
  },
  hasWorktreeChanges: async () => {
    worktreeState.changesCalls++
    return worktreeState.hasChanges
  },
  removeAgentWorktree: async (path: string) => {
    worktreeState.removed.push(path)
    return true
  },
}))

import {
  AGENT_MAX_RETRIES,
  AGENT_MAX_RETRIES_BY_REASON,
  WorkflowAbortedError,
} from '@open-claude-code/workflow-engine'
import {
  claudeCodeBackend,
  resolveAgentDefinition,
  mapWorkflowModel,
  describeMalformed,
  extractStructuredOutput,
  isGitLockContention,
  scanStructuredOutput,
  WORKFLOW_AGENT,
} from '../backends/claudeCodeBackend.js'
import { makeHostHandle } from '../hostHandle.js'

function ctx() {
  return {
    host: makeHostHandle({
      toolUseContext: {
        options: {
          agentDefinitions: { activeAgents: [] },
          querySource: 'workflow',
          mainLoopModel: 'm',
        },
        getAppState: () => ({
          toolPermissionContext: {
            mode: 'acceptEdits',
            alwaysAllowRules: {},
          },
          mcp: { tools: [] },
        }),
      } as never,
      canUseTool: (() => Promise.resolve({ behavior: 'allow' })) as never,
      // run() does not read parentMessage; use an empty object placeholder to satisfy the WorkflowHostBundle type.
      parentMessage: {} as never,
    }),
    signal: new AbortController().signal,
    runId: 'r1',
    agentId: 1,
  }
}

test('text agent → ok + token/tool/model accounting', async () => {
  const res = await claudeCodeBackend.run({ prompt: 'do it' }, ctx())
  expect(res.kind).toBe('ok')
  if (res.kind === 'ok') {
    expect(res.output).toBe('agent-text')
    expect(res.usage.outputTokens).toBe(42)
    // panel display fields: tokenCount(=totalTokens) / toolCount / model (fallback mainLoopModel 'm')
    expect(res.tokenCount).toBe(42)
    expect(res.toolCount).toBe(3)
    expect(res.model).toBe('m')
  }
})

test('isolation:worktree → create worktree + auto-cleanup on no changes; slug matches cleanup regex', async () => {
  worktreeState.shouldThrow = false
  worktreeState.hasChanges = false
  worktreeState.created = []
  worktreeState.removed = []
  worktreeState.changesCalls = 0
  const res = await claudeCodeBackend.run(
    { prompt: 'do', isolation: 'worktree' },
    ctx(),
  )
  expect(res.kind).toBe('ok')
  expect(worktreeState.created).toHaveLength(1)
  // slug must match cleanupStaleAgentWorktrees cleanup regex ^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$
  expect(worktreeState.created[0]).toMatch(/^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/)
  expect(worktreeState.changesCalls).toBe(1)
  expect(worktreeState.removed).toHaveLength(1) // no changes → auto-remove
})

test('isolation:worktree has changes → keep worktree (no remove)', async () => {
  worktreeState.hasChanges = true
  worktreeState.created = []
  worktreeState.removed = []
  worktreeState.changesCalls = 0
  const res = await claudeCodeBackend.run(
    { prompt: 'do', isolation: 'worktree' },
    ctx(),
  )
  expect(res.kind).toBe('ok')
  expect(worktreeState.removed).toHaveLength(0) // has changes → keep
  expect(worktreeState.changesCalls).toBe(1)
})

test('isolation:worktree creation fails → fail-closed dead, marked retryable:false', async () => {
  worktreeState.shouldThrow = true
  worktreeState.throwMessage = 'wt boom'
  const res = await claudeCodeBackend.run(
    { prompt: 'do', isolation: 'worktree' },
    ctx(),
  )
  expect(res.kind).toBe('dead')
  if (res.kind !== 'dead') throw new Error('unreachable')
  expect(res.reason).toBe('worktree-failed')
  // The causes are environmental and deterministic for an identical call (not a git repo,
  // no disk, branch taken). Without retryable:false the engine would burn its whole retry
  // budget re-running git plumbing before the agent has even started.
  expect(res.retryable).toBe(false)
  expect(res.detail).toContain('wt boom')
  worktreeState.shouldThrow = false
  worktreeState.throwMessage = 'wt boom'
})

test('isolation:worktree failing on git lock contention stays retryable (transient collision)', async () => {
  // Concurrent agents entering isolation race to fetch/create the same base ref with no
  // mutex in between; the loser dies on git's lock file. Raising the default concurrency
  // made this MORE likely, so marking it deterministic would be a net regression.
  for (const message of [
    "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    "error: cannot lock ref 'refs/heads/wf': is at ... but expected ...",
    'fatal: Unable to create /repo/.git/refs/remotes/origin/main.lock',
  ]) {
    worktreeState.shouldThrow = true
    worktreeState.throwMessage = message
    const res = await claudeCodeBackend.run(
      { prompt: 'do', isolation: 'worktree' },
      ctx(),
    )
    expect(res.kind).toBe('dead')
    if (res.kind !== 'dead') throw new Error('unreachable')
    expect(res.reason).toBe('worktree-failed')
    // absent (not false) → the engine's transient path, capped at 1 retry by
    // AGENT_MAX_RETRIES_BY_REASON['worktree-failed']
    expect(res.retryable).toBeUndefined()
  }
  worktreeState.shouldThrow = false
  worktreeState.throwMessage = 'wt boom'
})

test('isGitLockContention matches git lock signatures only', () => {
  expect(
    isGitLockContention("Unable to create '/r/.git/index.lock': File exists"),
  ).toBe(true)
  expect(isGitLockContention("cannot lock ref 'refs/heads/x'")).toBe(true)
  expect(isGitLockContention('UNABLE TO CREATE /r/foo.LOCK')).toBe(true) // case-insensitive
  // deterministic environment failures must not slip into the retryable bucket
  expect(isGitLockContention('not a git repository')).toBe(false)
  expect(isGitLockContention('No space left on device')).toBe(false)
  expect(isGitLockContention("branch 'wf_x' already exists")).toBe(false)
  expect(isGitLockContention('wt boom')).toBe(false)
})

test('the engine caps a retryable worktree-failed at one retry', () => {
  // Pins the pairing between the backend's classification and the engine budget: a lock
  // collision clears within one backoff or not at all, so it must not get the generic 3.
  expect(AGENT_MAX_RETRIES_BY_REASON['worktree-failed']).toBe(1)
  expect(AGENT_MAX_RETRIES_BY_REASON['worktree-failed']).toBeLessThan(
    AGENT_MAX_RETRIES,
  )
})

test('no isolation → no worktree created', async () => {
  worktreeState.created = []
  const res = await claudeCodeBackend.run({ prompt: 'do' }, ctx())
  expect(res.kind).toBe('ok')
  expect(worktreeState.created).toHaveLength(0)
})

test('runAgent throws → dead', async () => {
  // override mock so runAgent throws (last-write-wins)
  mock.module(
    '@open-claude-code/builtin-tools/tools/AgentTool/runAgent.js',
    () => ({
      // biome-ignore lint/correctness/useYield: intentionally throws to test dead branch (no yield)
      runAgent: async function* () {
        throw new Error('boom')
      },
    }),
  )
  const res = await claudeCodeBackend.run({ prompt: 'fail' }, ctx())
  expect(res.kind).toBe('dead')
})

// The next three groups of tests cover the 'x' invalid fix: backend must bridge ctx.signal to runAgent.override
// .abortController, and recognize AbortError as abort (throw WorkflowAbortedError, not swallow as dead).
// Also verify registerAgentAbort injection so service.kill(runId, agentId) can precisely abort a single agent.

test('ctx.signal pre-abort → backend bridge: override.abortController.signal.aborted=true', async () => {
  // use capturedOverride to expose the agentAbort created by backend (the override.abortController received by mock)
  let capturedController: AbortController | undefined
  mock.module(
    '@open-claude-code/builtin-tools/tools/AgentTool/runAgent.js',
    () => ({
      runAgent: async function* (opts: {
        override?: { abortController?: AbortController }
      }) {
        capturedController = opts.override?.abortController
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'x' }] },
        }
      },
    }),
  )
  const parentAbort = new AbortController()
  parentAbort.abort()
  // mock does not throw → backend takes the normal return path; but the bridge `if (ctx.signal.aborted) agentAbort.abort()`
  // has already triggered synchronously, capturedController.signal.aborted must be true (root cause of kill bridge)
  await claudeCodeBackend.run(
    { prompt: 'pre-aborted' },
    { ...ctx(), signal: parentAbort.signal },
  )
  expect(capturedController?.signal.aborted).toBe(true)
})

test('runAgent throws AbortError → backend throws WorkflowAbortedError (not swallowed as dead)', async () => {
  mock.module(
    '@open-claude-code/builtin-tools/tools/AgentTool/runAgent.js',
    () => ({
      // biome-ignore lint/correctness/useYield: intentionally throws AbortError to test recognition branch
      runAgent: async function* () {
        const e = new Error('aborted by parent')
        e.name = 'AbortError'
        throw e
      },
    }),
  )
  await expect(
    claudeCodeBackend.run({ prompt: 'abort' }, ctx()),
  ).rejects.toBeInstanceOf(WorkflowAbortedError)
})

test('registerAgentAbort/unregisterAgentAbort injection: key=ctx.agentId (number), controller from bridge', async () => {
  // restore default mock (previous test changed it to throw AbortError)
  mock.module(
    '@open-claude-code/builtin-tools/tools/AgentTool/runAgent.js',
    () => ({
      runAgent: async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'agent-text' }] },
        }
      },
    }),
  )
  const registered: Array<{ id: number; controller: AbortController }> = []
  const unregistered: number[] = []
  await claudeCodeBackend.run(
    { prompt: 'wiring' },
    {
      ...ctx(),
      agentId: 42,
      registerAgentAbort: (id, ac) => registered.push({ id, controller: ac }),
      unregisterAgentAbort: id => unregistered.push(id),
    },
  )
  expect(registered).toHaveLength(1)
  expect(registered[0]?.id).toBe(42) // engine numeric agentId (not coreAgentId string)
  expect(registered[0]?.controller).toBeInstanceOf(AbortController)
  expect(unregistered).toEqual([42]) // finally cleanup idempotent
})

// query() surfaces terminal API errors as an assistant message (isApiErrorMessage) and ends the
// generator without throwing. The backend must classify them as dead — previously the error text
// was returned as the agent's "answer" (non-schema) or misclassified as no-structured-output (schema).

test('terminal API error: prompt-too-long → dead retryable:false (deterministic, engine skips retry)', async () => {
  mock.module(
    '@open-claude-code/builtin-tools/tools/AgentTool/runAgent.js',
    () => ({
      runAgent: async function* () {
        yield {
          type: 'assistant',
          isApiErrorMessage: true,
          message: {
            content: [{ type: 'text', text: 'Prompt is too long' }],
          },
        }
      },
    }),
  )
  const res = await claudeCodeBackend.run({ prompt: 'huge' }, ctx())
  expect(res.kind).toBe('dead')
  if (res.kind === 'dead') {
    expect(res.reason).toBe('prompt-too-long')
    expect(res.retryable).toBe(false)
    expect(res.detail).toMatch(/Prompt is too long/)
  }
})

test('terminal API error: other API error → dead reason api-error (transient, engine may retry)', async () => {
  mock.module(
    '@open-claude-code/builtin-tools/tools/AgentTool/runAgent.js',
    () => ({
      runAgent: async function* () {
        yield {
          type: 'assistant',
          isApiErrorMessage: true,
          message: {
            content: [{ type: 'text', text: 'API Error: 529 overloaded' }],
          },
        }
      },
    }),
  )
  const res = await claudeCodeBackend.run({ prompt: 'x' }, ctx())
  expect(res.kind).toBe('dead')
  if (res.kind === 'dead') {
    expect(res.reason).toBe('api-error')
    expect(res.retryable).not.toBe(false)
    expect(res.detail).toMatch(/529/)
  }
  // restore the default runAgent mock for any later run() in this process
  mock.module(
    '@open-claude-code/builtin-tools/tools/AgentTool/runAgent.js',
    () => ({
      runAgent: async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'agent-text' }] },
        }
      },
    }),
  )
})

test('id and capabilities shape', () => {
  expect(claudeCodeBackend.id).toBe('claude-code')
  expect(claudeCodeBackend.capabilities.structuredOutput).toBe(true)
  expect(claudeCodeBackend.capabilities.tools).toBe(true)
})

test('resolveAgentDefinition: no agentType → WORKFLOW_AGENT fallback', () => {
  const tuc = {
    options: { agentDefinitions: { activeAgents: [] } },
  } as never
  expect(resolveAgentDefinition(undefined, tuc)).toBe(WORKFLOW_AGENT)
})

test('resolveAgentDefinition: hits activeAgents', () => {
  const fake = { agentType: 'Explore', permissionMode: 'plan' } as never
  const tuc = {
    options: { agentDefinitions: { activeAgents: [fake] } },
  } as never
  expect(resolveAgentDefinition('Explore', tuc)).toBe(fake)
  // miss still falls back
  expect(resolveAgentDefinition('Nope', tuc)).toBe(WORKFLOW_AGENT)
})

test('mapWorkflowModel passthrough', () => {
  expect(mapWorkflowModel(undefined)).toBeUndefined()
  expect(mapWorkflowModel('claude-haiku-*')).toBe('claude-haiku-*')
})

test('extractStructuredOutput: valid JSON extracted; invalid returns null', () => {
  expect(
    extractStructuredOutput([
      { type: 'text', text: 'prefix {"a":1,"b":2} suffix' },
    ]),
  ).toEqual({ a: 1, b: 2 })
  expect(
    extractStructuredOutput([{ type: 'text', text: 'no json here' }]),
  ).toBeNull()
  expect(extractStructuredOutput([])).toBeNull()
})

test('extractStructuredOutput: fenced code block (strip fence + strip language tag)', () => {
  expect(
    extractStructuredOutput([
      {
        type: 'text',
        text: 'Here are the findings:\n```json\n{"findings":[{"title":"x"}]}\n```\nDone.',
      },
    ]),
  ).toEqual({ findings: [{ title: 'x' }] })
  // no language tag
  expect(
    extractStructuredOutput([{ type: 'text', text: '```\n{"a":1}\n```' }]),
  ).toEqual({ a: 1 })
})

test('extractStructuredOutput: nested object (bracket-balanced scan; legacy indexOf/lastIndexOf would cross-block concat)', () => {
  const text = 'Result: {"outer":{"inner":{"deep":true}},"n":3} trailing'
  expect(extractStructuredOutput([{ type: 'text', text }])).toEqual({
    outer: { inner: { deep: true } },
    n: 3,
  })
})

test('extractStructuredOutput: brackets inside strings are not counted as pairing', () => {
  // } inside a string does not zero out depth, scan can skip to the real pairing }
  const text = '{"note":"this } char is in a string","ok":true}'
  expect(extractStructuredOutput([{ type: 'text', text }])).toEqual({
    note: 'this } char is in a string',
    ok: true,
  })
})

test('extractStructuredOutput: escaped quotes do not break string boundary', () => {
  const text = '{"escaped":"he said \\"hi\\"","n":1}'
  expect(extractStructuredOutput([{ type: 'text', text }])).toEqual({
    escaped: 'he said "hi"',
    n: 1,
  })
})

test('extractStructuredOutput: multiple JSON blocks → return first parse success', () => {
  // first one unbalanced (no pairing }), skip to the second
  const text = 'broken { stuff\n{"real":1}\n{"ignored":2}'
  expect(extractStructuredOutput([{ type: 'text', text }])).toEqual({ real: 1 })
})

test('extractStructuredOutput: array / number / string / null do not count as object', () => {
  expect(
    extractStructuredOutput([{ type: 'text', text: '[1,2,3]' }]),
  ).toBeNull()
  expect(extractStructuredOutput([{ type: 'text', text: '42' }])).toBeNull()
  expect(
    extractStructuredOutput([{ type: 'text', text: '"raw string"' }]),
  ).toBeNull()
  expect(extractStructuredOutput([{ type: 'text', text: 'null' }])).toBeNull()
})

test('extractStructuredOutput: multiple text blocks → cross-block find first success', () => {
  expect(
    extractStructuredOutput([
      { type: 'text', text: 'no json' },
      { type: 'text', text: '```json\n{"k":"v"}\n```' },
    ]),
  ).toEqual({ k: 'v' })
})

test('extractStructuredOutput: broken JSON returns null (does not throw)', () => {
  expect(
    extractStructuredOutput([
      { type: 'text', text: '{broken: missing quotes}' },
    ]),
  ).toBeNull()
  expect(
    extractStructuredOutput([{ type: 'text', text: '{"a":1,}' }]), // trailing comma — no syntax repair
  ).toBeNull()
})

test('extractStructuredOutput: a rejected object is never mined for its nested values', () => {
  // Regression, from a real research run. The agent emitted a well-formed top-level object whose
  // prose contained one unescaped `"` (`属"扩张中的尾部收缩"`). The object balances, so the scan
  // reached it — but JSON.parse rejects it. Resuming the scan one char later used to walk INTO the
  // wreck and return the value of `fields` as a complete `kind:'ok'` answer: `search_audit` and the
  // other top-level keys silently vanished and the workflow consumed the fragment as real data.
  const text = [
    '{',
    '  "market": "US",',
    '  "md_section": "结论:属"扩张中的尾部收缩",非系统性风险。",',
    '  "fields": {"credit_cycle": {"stage": "扩张"}},',
    '  "search_audit": {"legs": 2}',
    '}',
  ].join('\n')
  expect(extractStructuredOutput([{ type: 'text', text }])).toBeNull()
})

test('scanStructuredOutput: reports the parse error rather than silently returning null', () => {
  const scan = scanStructuredOutput([
    { type: 'text', text: '{"market": "US", "note": "he said "hi" loudly"}' },
  ])
  expect(scan.value).toBeNull()
  // Without this the caller only knows "no JSON found", which for a malformed answer is actively
  // misleading — the JSON is right there. Both engines name the fault; only V8 gives a position.
  expect(scan.malformed?.error).toMatch(/JSON/i)
  expect(scan.malformed?.excerpt.length).toBeGreaterThan(0)
})

test('describeMalformed: excerpt centres on the position V8 reports, not the head', () => {
  // Fed a synthetic V8 message on purpose: the suite runs on bun/JSC, which omits the position, so
  // asserting through a live JSON.parse would silently test nothing on this runtime while the
  // shipped bin (node/V8) takes the branch that matters.
  const candidate = `{"pad": "${'x'.repeat(400)}", "note": "he said "BOOM" loudly"}`
  const pos = candidate.indexOf('BOOM')
  const d = describeMalformed(
    candidate,
    0,
    `Expected ',' or '}' after property value in JSON at position ${pos}`,
  )
  expect(d?.excerpt).toContain('BOOM')
  expect(d?.excerpt).not.toContain('"pad"') // the healthy head is exactly what must be cropped out
})

test('describeMalformed: prose that is not JSON-shaped is not reported as malformed', () => {
  expect(describeMalformed('just narration', 0, undefined)).toBeUndefined()
})

test('scanStructuredOutput: no JSON at all reports no malformed candidate', () => {
  const scan = scanStructuredOutput([{ type: 'text', text: 'just narration' }])
  expect(scan.value).toBeNull()
  expect(scan.malformed).toBeUndefined()
})

test('scanStructuredOutput: a valid object still wins over an earlier rejected one', () => {
  // Skipping a failed candidate whole must not stop the scan: a later, valid top-level object
  // is still the answer.
  const scan = scanStructuredOutput([
    { type: 'text', text: '{"a":1,}\n{"real":true}' },
  ])
  expect(scan.value).toEqual({ real: true })
})
