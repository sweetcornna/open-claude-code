import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowTool } from '../tool/WorkflowTool.js'
import { DEFAULT_MAX_CONCURRENCY, MAX_CONCURRENCY_CAP } from '../constants.js'
import { createHostHandle, type WorkflowPorts } from '../ports.js'
import type {
  AgentRunParams,
  AgentRunResult,
  JournalEntry,
  ProgressEvent,
} from '../types.js'

function mockPorts(
  runsDir: string,
  results: Map<string, AgentRunResult>,
): {
  ports: WorkflowPorts
  events: ProgressEvent[]
  runStatus: Map<string, string>
  truncated: string[]
} {
  const events: ProgressEvent[] = []
  const runStatus = new Map<string, string>()
  const truncated: string[] = []
  const journal = new Map<string, JournalEntry[]>()
  const ports: WorkflowPorts = {
    agentRunner: {
      runAgentToResult: async (p: AgentRunParams) =>
        results.get(p.prompt) ?? { kind: 'dead' },
    },
    progressEmitter: { emit: e => void events.push(e) },
    taskRegistrar: {
      register: () => ({
        runId: 'run-x',
        signal: new AbortController().signal,
      }),
      complete: id => void runStatus.set(id, 'completed'),
      fail: id => void runStatus.set(id, 'failed'),
      kill: id => void runStatus.set(id, 'killed'),
      pendingAction: () => null,
    },
    journalStore: {
      read: async runId => [...(journal.get(runId) ?? [])],
      append: async (runId, entry) => {
        const entries = journal.get(runId) ?? []
        entries.push(entry)
        journal.set(runId, entries)
      },
      truncate: async runId => {
        truncated.push(runId)
        journal.delete(runId)
      },
    },
    permissionGate: { isAborted: () => false },
    logger: { debug: () => {}, event: () => {} },
    hostFactory: () => ({
      handle: createHostHandle(null),
      cwd: runsDir,
      budgetTotal: null,
    }),
  }
  return { ports, events, runStatus, truncated }
}

test('call returns launch message and completes in background', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const { ports, runStatus } = mockPorts(
      dir,
      new Map([
        ['compute', { kind: 'ok', output: '42', usage: { outputTokens: 1 } }],
      ]),
    )
    const tool = createWorkflowTool(ports)
    const res = await tool.call(
      { script: `return agent('compute')` },
      undefined,
      undefined,
      undefined,
    )
    expect(res.data.output).toContain('run_id: run-x')
    await new Promise(r => {
      setTimeout(r, 50)
    })
    expect(runStatus.get('run-x')).toBe('completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('host options override named workflow and run directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const workflowDir = join('.custom', 'workflows')
    const workflowRunsDir = join('.custom', 'workflow-runs')
    await mkdir(join(dir, workflowDir), { recursive: true })
    await writeFile(join(dir, workflowDir, 'named.js'), 'return 1')
    const { ports } = mockPorts(dir, new Map())
    const tool = createWorkflowTool(ports, { workflowDir, workflowRunsDir })

    expect(await tool.prompt()).toContain('.custom/workflows/')
    expect(await tool.prompt()).not.toContain('.occ/workflows/')

    const named = await tool.call(
      { name: 'named' },
      undefined,
      undefined,
      undefined,
    )
    expect(named.data.output).toContain(join(dir, workflowDir, 'named.js'))

    const inline = await tool.call(
      { script: 'return 1' },
      undefined,
      undefined,
      undefined,
    )
    expect(inline.data.output).toContain(
      join(dir, workflowRunsDir, 'run-x', 'script.js'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('inline script persists to run directory, returns real scriptPath', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const { ports } = mockPorts(
      dir,
      new Map([['x', { kind: 'ok', output: 'x', usage: { outputTokens: 1 } }]]),
    )
    const tool = createWorkflowTool(ports)
    const res = await tool.call(
      { script: `return agent('x')` },
      undefined,
      undefined,
      undefined,
    )
    const expectedPath = join(
      dir,
      '.occ',
      'workflow-runs',
      'run-x',
      'script.js',
    )
    expect(res.data.output).toContain(expectedPath)
    expect(await readFile(expectedPath, 'utf-8')).toBe(`return agent('x')`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('default resume leaves changed-script journal invalidation to chained checkpoint identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-hash-'))
  try {
    const { ports, events, truncated } = mockPorts(
      dir,
      new Map([
        ['first', { kind: 'ok', output: 'first', usage: { outputTokens: 1 } }],
      ]),
    )
    const tool = createWorkflowTool(ports)
    await tool.call(
      { script: `return agent('first')` },
      undefined,
      undefined,
      undefined,
    )
    const scriptPath = join(dir, '.occ', 'workflow-runs', 'run-x', 'script.js')
    const hashPath = join(
      dir,
      '.occ',
      'workflow-runs',
      'run-x',
      'script.sha256',
    )
    expect(await readFile(hashPath, 'utf-8')).toMatch(/^[a-f0-9]{64}\n$/)

    await new Promise(resolve => setTimeout(resolve, 30))
    events.length = 0
    await writeFile(
      scriptPath,
      `const value = await agent('first'); return value + '!'`,
      'utf-8',
    )
    await tool.call(
      { scriptPath, resumeFromRunId: 'run-x' },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(truncated).toEqual([])
    expect(
      events.some(
        event => event.type === 'agent_done' && event.execution === 'replayed',
      ),
    ).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('changed script rejects selective resume before registration and preserves the prior hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-selective-hash-'))
  try {
    const { ports, truncated } = mockPorts(
      dir,
      new Map([
        ['first', { kind: 'ok', output: 'first', usage: { outputTokens: 1 } }],
        [
          'second',
          { kind: 'ok', output: 'second', usage: { outputTokens: 1 } },
        ],
      ]),
    )
    const tool = createWorkflowTool(ports)
    await tool.call(
      { script: `return agent('first')` },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(resolve => setTimeout(resolve, 30))
    const scriptPath = join(dir, '.occ', 'workflow-runs', 'run-x', 'script.js')
    const hashPath = join(
      dir,
      '.occ',
      'workflow-runs',
      'run-x',
      'script.sha256',
    )
    const priorHash = await readFile(hashPath, 'utf-8')
    await writeFile(scriptPath, `return agent('second')`, 'utf-8')

    const result = await tool.call(
      {
        scriptPath,
        resumeFromRunId: 'run-x',
        resumePolicy: { scope: 'agents', agentIds: [0] },
      },
      undefined,
      undefined,
      undefined,
    )

    expect(result.data.output).toMatch(/^Error: selective resume/)
    expect(truncated).toEqual([])
    expect(await readFile(hashPath, 'utf-8')).toBe(priorHash)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('default resume without prior script hash delegates safely to checkpoint identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-hash-missing-'))
  try {
    const scriptPath = join(dir, 'legacy-workflow.js')
    await writeFile(scriptPath, 'return 1', 'utf-8')
    const { ports, truncated } = mockPorts(dir, new Map())
    const tool = createWorkflowTool(ports)

    await tool.call(
      { scriptPath, resumeFromRunId: 'run-x' },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(resolve => {
      setTimeout(resolve, 30)
    })

    expect(truncated).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('missing script/name/scriptPath → returns error (does not enter background)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const { ports, runStatus } = mockPorts(dir, new Map())
    const tool = createWorkflowTool(ports)
    const res = await tool.call({}, undefined, undefined, undefined)
    expect(res.data.output).toMatch(/^Error:/)
    expect(runStatus.size).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('script syntax error → returns validation error (does not enter background)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const { ports, runStatus } = mockPorts(dir, new Map())
    const tool = createWorkflowTool(ports)
    const res = await tool.call(
      { script: `return ((` },
      undefined,
      undefined,
      undefined,
    )
    expect(res.data.output).toMatch(/validation failed|Error/i)
    expect(runStatus.size).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('name resolves to .occ/workflows/<name>.ts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    await mkdir(join(dir, '.occ', 'workflows'), { recursive: true })
    await writeFile(
      join(dir, '.occ', 'workflows', 'release.ts'),
      `return agent('compute')`,
    )
    const { ports, runStatus } = mockPorts(
      dir,
      new Map([
        ['compute', { kind: 'ok', output: 'done', usage: { outputTokens: 1 } }],
      ]),
    )
    const tool = createWorkflowTool(ports)
    const res = await tool.call(
      { name: 'release' },
      undefined,
      undefined,
      undefined,
    )
    expect(res.data.output).toContain('run_id')
    await new Promise(r => {
      setTimeout(r, 50)
    })
    expect(runStatus.get('run-x')).toBe('completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('renderToolUseMessage / mapToolResultToToolResultBlockParam', () => {
  const dir = '/tmp'
  const { ports } = mockPorts(dir, new Map())
  const tool = createWorkflowTool(ports)
  expect(tool.renderToolUseMessage({ name: 'release' })).toBe(
    'Workflow: release',
  )
  const block = tool.mapToolResultToToolResultBlockParam(
    { output: 'hi' },
    'tu-1',
  )
  expect(block.tool_use_id).toBe('tu-1')
  expect(block.type).toBe('tool_result')
  expect(block.content[0]!.text).toBe('hi')
})

test('scriptPath resolves to file content and runs in background', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const scriptFile = join(dir, 'external.ts')
    await writeFile(scriptFile, `return agent('compute')`)
    const { ports, runStatus } = mockPorts(
      dir,
      new Map([
        ['compute', { kind: 'ok', output: 'done', usage: { outputTokens: 1 } }],
      ]),
    )
    const tool = createWorkflowTool(ports)
    const res = await tool.call(
      { scriptPath: scriptFile },
      undefined,
      undefined,
      undefined,
    )
    expect(res.data.output).toContain('run_id')
    expect(res.data.output).toContain('external.ts')
    await new Promise(r => {
      setTimeout(r, 50)
    })
    expect(runStatus.get('run-x')).toBe('completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('script runtime failure → onFinish routes to fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const { ports, runStatus } = mockPorts(dir, new Map())
    const tool = createWorkflowTool(ports)
    await tool.call(
      { script: `throw new Error('boom')` },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(r => {
      setTimeout(r, 50)
    })
    expect(runStatus.get('run-x')).toBe('failed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('metadata methods: description/prompt/renderToolUseMessage', async () => {
  const { ports } = mockPorts('/tmp', new Map())
  const tool = createWorkflowTool(ports)
  expect(tool.isEnabled()).toBe(true)
  expect(tool.isReadOnly({})).toBe(false)
  expect(await tool.description()).toBeTruthy()
  expect(await tool.prompt()).toContain('Workflow')
  expect(tool.renderToolUseMessage({})).toBe('Workflow: unknown')
  expect(tool.renderToolUseMessage({ resumeFromRunId: 'r1' })).toBe(
    'Workflow resume: r1',
  )
})

test('prompt states the real default concurrency + AskUserQuestion guidance', async () => {
  const { ports } = mockPorts('/tmp', new Map())
  const tool = createWorkflowTool(ports)
  const p = await tool.prompt()
  expect(p).toContain('.occ/workflows/')
  expect(p).not.toContain('.claude/workflows/')
  // Interpolated from the constant: the model is told to ask the user before using any
  // non-default value, so a prompt quoting a stale default makes it interrupt for the
  // very value it should have used silently.
  expect(p).toContain(`default is ${DEFAULT_MAX_CONCURRENCY}`)
  expect(p).toContain(`hard ceiling ${MAX_CONCURRENCY_CAP}`)
  expect(p).toMatch(/maxConcurrency/i)
  expect(p).toMatch(/AskUserQuestion/i)
})

test('prompt states the run opt-in gate and its three routes', async () => {
  // isEnabled() is unconditionally true and the prompt sits in the cached tool
  // block, so the opt-in constraint can only live in this text. Without it the
  // model sees a freely callable tool that fans out dozens of agents.
  const { ports } = mockPorts('/tmp', new Map())
  const p = await createWorkflowTool(ports).prompt()

  expect(p).toContain('Run requires an explicit opt-in')
  // (a) session mode, (b) the user's own words, (c) a skill that says to.
  expect(p).toContain('ultracode mode is ON')
  expect(p).toContain('in their own words')
  expect(p).toContain('/ultracode')
  expect(p).toContain('do not call run')
  // Read-only operations must stay reachable without an opt-in.
  expect(p).toContain('status and cancel need no opt-in')
  // The /ultracode pointer is now one opt-in route, not a standing suggestion.
  expect(p).not.toContain(
    'See /ultracode for the full playbook and quality patterns',
  )
})

test('defaultMaxConcurrency fills an omitted maxConcurrency; an explicit input still wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-mc-'))
  try {
    // Peak observed overlap is the only externally visible proof of the permit count.
    const peakFor = async (
      input: { script: string; maxConcurrency?: number },
      defaultMaxConcurrency: number,
    ): Promise<number> => {
      const { ports, runStatus } = mockPorts(dir, new Map())
      let active = 0
      let peak = 0
      ports.agentRunner = {
        runAgentToResult: async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise(r => {
            setTimeout(r, 10)
          })
          active--
          return { kind: 'ok', output: 'x', usage: { outputTokens: 1 } }
        },
      }
      const tool = createWorkflowTool(ports, { defaultMaxConcurrency })
      await tool.call(input, undefined, undefined, undefined)
      // the run is detached; wait for the registrar to see it finish
      for (let i = 0; i < 100 && runStatus.size === 0; i++) {
        await new Promise(r => {
          setTimeout(r, 10)
        })
      }
      return peak
    }

    const fanOut = `return parallel([() => agent('a'), () => agent('b'), () => agent('c'), () => agent('d')])`
    // omitted → the host default takes effect (would be DEFAULT_MAX_CONCURRENCY without it)
    expect(await peakFor({ script: fanOut }, 1)).toBe(1)
    // explicit input beats the host default in both directions
    expect(await peakFor({ script: fanOut, maxConcurrency: 4 }, 1)).toBe(4)
    expect(await peakFor({ script: fanOut, maxConcurrency: 1 }, 4)).toBe(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('name does not exist → returns error (does not enter background)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    await mkdir(join(dir, '.occ', 'workflows'), { recursive: true })
    const { ports, runStatus } = mockPorts(dir, new Map())
    const tool = createWorkflowTool(ports)
    const res = await tool.call(
      { name: 'nope' },
      undefined,
      undefined,
      undefined,
    )
    expect(res.data.output).toMatch(/^Error:/)
    expect(runStatus.size).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('workflow aborted → onFinish routes to kill', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const runStatus = new Map<string, string>()
    const ac = new AbortController()
    const ports: WorkflowPorts = {
      agentRunner: {
        runAgentToResult: async () => ({
          kind: 'ok',
          output: 'x',
          usage: { outputTokens: 1 },
        }),
      },
      progressEmitter: { emit: () => {} },
      taskRegistrar: {
        register: () => ({ runId: 'run-x', signal: ac.signal }),
        complete: id => void runStatus.set(id, 'completed'),
        fail: id => void runStatus.set(id, 'failed'),
        kill: id => void runStatus.set(id, 'killed'),
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
        cwd: dir,
        budgetTotal: null,
      }),
    }
    ac.abort()
    const tool = createWorkflowTool(ports)
    await tool.call(
      { script: `return agent('x')` },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(r => {
      setTimeout(r, 50)
    })
    expect(runStatus.get('run-x')).toBe('killed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('args defensively parses when a JSON-stringified object (backward compatible with old z.string() contract)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const capturedPrompts: unknown[] = []
    const ports: WorkflowPorts = {
      agentRunner: {
        runAgentToResult: async (p: AgentRunParams) => {
          capturedPrompts.push(p.prompt)
          return { kind: 'ok', output: 'done', usage: { outputTokens: 1 } }
        },
      },
      progressEmitter: { emit: () => {} },
      taskRegistrar: {
        register: () => ({
          runId: 'run-x',
          signal: new AbortController().signal,
        }),
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
        cwd: dir,
        budgetTotal: null,
      }),
    }
    const tool = createWorkflowTool(ports)
    await tool.call(
      {
        script: `return agent(args.commit)`,
        // simulate stringified JSON sent by model under old contract
        args: '{"commit":"abc123"}',
      },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(r => {
      setTimeout(r, 50)
    })
    // if args not normalized: args.commit === undefined (string has no commit property)
    // if args normalized: args.commit === 'abc123'
    expect(capturedPrompts).toContain('abc123')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('args keeps original value for non-legal JSON string without throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const capturedPrompts: unknown[] = []
    const ports: WorkflowPorts = {
      agentRunner: {
        runAgentToResult: async (p: AgentRunParams) => {
          capturedPrompts.push(p.prompt)
          return { kind: 'ok', output: 'ok', usage: { outputTokens: 1 } }
        },
      },
      progressEmitter: { emit: () => {} },
      taskRegistrar: {
        register: () => ({
          runId: 'run-x',
          signal: new AbortController().signal,
        }),
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
        cwd: dir,
        budgetTotal: null,
      }),
    }
    const tool = createWorkflowTool(ports)
    await tool.call(
      {
        // script uses args as a string: agent(args) → agent('hello')
        script: `return agent(args)`,
        args: 'hello',
      },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(r => {
      setTimeout(r, 50)
    })
    // 'hello' is not valid JSON, should be kept as a string
    expect(capturedPrompts).toContain('hello')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scriptPath out of bounds (resolved outside cwd) → rejected with error (prevents arbitrary file read)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const subDir = join(dir, 'sub')
    await mkdir(subDir, { recursive: true })
    // place a script outside subDir (inside dir)
    const outsideScript = join(dir, 'outside.ts')
    await writeFile(outsideScript, `return agent('x')`)
    // host.cwd = subDir, scriptPath is an absolute path outside subDir
    const { ports, runStatus } = mockPorts(subDir, new Map())
    const tool = createWorkflowTool(ports)
    const res = await tool.call(
      { scriptPath: outsideScript },
      undefined,
      undefined,
      undefined,
    )
    expect(res.data.output).toMatch(/^Error:/)
    expect(res.data.output).toMatch(/out of bounds|outside|not within/i)
    expect(runStatus.size).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('name contains ".." path segment → rejected (prevents path traversal escaping workflowDir)', async () => {
  const outer = await mkdtemp(join(tmpdir(), 'wf-outer-'))
  try {
    // place evil.ts at outer root (outside .occ/workflows)
    await writeFile(join(outer, 'evil.ts'), `return agent('x')`)
    await mkdir(join(outer, '.occ', 'workflows'), { recursive: true })
    const { ports, runStatus } = mockPorts(outer, new Map())
    const tool = createWorkflowTool(ports)
    // name = '../../evil' → after join escapes the workflows directory to outer/evil.ts
    const res = await tool.call(
      { name: '../../evil' },
      undefined,
      undefined,
      undefined,
    )
    expect(res.data.output).toMatch(/^Error:/)
    expect(runStatus.size).toBe(0)
  } finally {
    await rm(outer, { recursive: true, force: true })
  }
})

test('name contains path separators or is absolute → rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    await mkdir(join(dir, '.occ', 'workflows'), { recursive: true })
    const { ports } = mockPorts(dir, new Map())
    const tool = createWorkflowTool(ports)
    for (const badName of ['foo/bar', '/etc/passwd', '..', '.']) {
      const res = await tool.call(
        { name: badName },
        undefined,
        undefined,
        undefined,
      )
      expect(res.data.output).toMatch(/^Error:/)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('returnValue is an object → complete (formatValue takes JSON branch)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const { ports, runStatus } = mockPorts(
      dir,
      new Map([['x', { kind: 'ok', output: 'x', usage: { outputTokens: 1 } }]]),
    )
    const tool = createWorkflowTool(ports)
    await tool.call(
      {
        script: `await agent('x')\nreturn { ok: true, n: 1 }`,
      },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(r => {
      setTimeout(r, 50)
    })
    expect(runStatus.get('run-x')).toBe('completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('launch message names the run directory and the files inside it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const { ports } = mockPorts(
      dir,
      new Map([['x', { kind: 'ok', output: 'x', usage: { outputTokens: 1 } }]]),
    )
    const tool = createWorkflowTool(ports, {
      workflowRunsDir: '.occ/workflow-runs',
    })
    const res = await tool.call(
      { script: `return agent('x')` },
      undefined,
      undefined,
      undefined,
    )

    // Without this the only way to find a finished run's journal is to guess.
    const expectedRunDir = join(dir, '.occ/workflow-runs', 'run-x')
    expect(res.data.output).toContain(`run_dir: ${expectedRunDir}`)
    expect(res.data.output).toContain(join(expectedRunDir, 'journal.jsonl'))
    expect(res.data.output).toContain(join(expectedRunDir, 'state.json'))

    // The advertised directory must be the one actually written to.
    await new Promise(r => {
      setTimeout(r, 50)
    })
    expect(
      await readFile(join(expectedRunDir, 'script.sha256'), 'utf-8'),
    ).toMatch(/^[0-9a-f]{64}\n$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent duplicate resumes reuse one registration and launch one engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-single-flight-'))
  try {
    const { ports } = mockPorts(dir, new Map())
    let engineCalls = 0
    let releaseEngine: (() => void) | undefined
    const engineBlocked = new Promise<void>(resolve => {
      releaseEngine = resolve
    })
    ports.agentRunner = {
      runAgentToResult: async () => {
        engineCalls++
        await engineBlocked
        return { kind: 'ok', output: 'done', usage: { outputTokens: 1 } }
      },
    }

    const controller = new AbortController()
    const canonical = {
      runId: 'run-resume',
      taskId: 'w-wrapper',
      signal: controller.signal,
      instanceId: 7,
    } as const
    let registrations = 0
    ports.taskRegistrar.getActive = () =>
      registrations > 0 ? { ...canonical, disposition: 'existing' } : undefined
    ports.taskRegistrar.register = () => {
      registrations++
      return { ...canonical, disposition: 'created' }
    }

    const tool = createWorkflowTool(ports)
    const first = await tool.call(
      { script: `return agent('x')`, resumeFromRunId: 'run-resume' },
      undefined,
      undefined,
      undefined,
    )
    const duplicate = await tool.call(
      { script: `return ((`, resumeFromRunId: 'run-resume' },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(resolve => {
      setTimeout(resolve, 10)
    })

    expect(first.data.output).toContain('Workflow started')
    expect(duplicate.data.output).toContain('already running')
    expect(duplicate.data.output).toContain('task_id: w-wrapper')
    expect(registrations).toBe(1)
    expect(engineCalls).toBe(1)

    releaseEngine?.()
    await new Promise(resolve => {
      setTimeout(resolve, 30)
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('status/query returns active wrapper and bounded per-agent live/durable state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-status-'))
  try {
    const { ports } = mockPorts(dir, new Map())
    const signal = new AbortController().signal
    let active = true
    ports.taskRegistrar.getActive = () =>
      active
        ? {
            runId: 'run-status',
            taskId: 'w-wrapper',
            instanceId: 9,
            signal,
            disposition: 'existing',
          }
        : undefined
    ports.runStatusReader = {
      async getRun() {
        return {
          runId: 'run-status',
          taskId: 'w-wrapper',
          instanceId: 9,
          workflowName: 'research',
          status: active ? 'running' : 'failed',
          currentPhase: 'verify',
          updatedAt: 1234,
          runDir: join(dir, '.occ', 'workflow-runs', 'run-status'),
          returnValue: { partial: true },
          error: 'terminal error',
          agents: [
            {
              id: 3,
              label: 'checker',
              phase: 'verify',
              status: 'done',
              execution: 'replayed',
              resultKind: 'dead',
              tokenCount: 42,
              toolCount: 2,
              lastActivityAt: 1200,
              retryCount: 1,
              retryLimit: 3,
              lastFailureReason: 'api-error',
              failureReason: 'prompt-too-long',
              failureDetail: 'x'.repeat(600),
              retryable: false,
            },
            {
              id: 4,
              label: 'writer',
              phase: 'verify',
              status: active ? 'running' : 'done',
              execution: 'live',
              ...(!active ? { resultKind: 'ok' } : {}),
              tokenCount: 8,
              toolCount: 3,
              startedAt: 1210,
              lastActivityAt: 1220,
            },
          ],
        }
      },
    }

    const tool = createWorkflowTool(ports)
    const res = await tool.call(
      { operation: 'query', runId: 'run-status' },
      undefined,
      undefined,
      undefined,
    )
    const status = JSON.parse(res.data.output)

    expect(status.wrapper).toEqual({
      active: true,
      task_id: 'w-wrapper',
      instance_id: 9,
    })
    expect(status.totals).toEqual({
      token_count: 50,
      tool_count: 5,
      agent_count: 2,
      running_count: 1,
      done_count: 1,
      replayed_count: 1,
      live_count: 1,
    })
    expect(status.status).toBe('running')
    expect(status.workflow).toBe('research')
    expect(status.phase).toBe('verify')
    expect(status.updated_at).toBe(1234)
    expect(status.return_value).toBeUndefined()
    expect(status.error).toBeUndefined()
    expect(status.run_dir).toContain('run-status')
    expect(status.agents[0]).toMatchObject({
      id: 3,
      label: 'checker',
      status: 'done',
      execution: 'replayed',
      token_count: 42,
      tool_count: 2,
      last_activity_at: 1200,
    })
    expect(status.agents[0].retry).toMatchObject({
      count: 1,
      limit: 3,
      reason: 'api-error',
    })
    expect(status.agents[0].failure.reason).toBe('prompt-too-long')
    expect(status.agents[0].failure.detail.length).toBeLessThanOrEqual(401)

    // Once the active binding is released, status falls back to the identity
    // persisted with the terminal RunProgress instead of losing generation data.
    active = false
    const terminal = JSON.parse(
      (
        await tool.call(
          { operation: 'status', runId: 'run-status' },
          undefined,
          undefined,
          undefined,
        )
      ).data.output,
    )
    expect(terminal.wrapper).toEqual({
      active: false,
      task_id: 'w-wrapper',
      instance_id: 9,
    })
    expect(terminal.status).toBe('failed')
    expect(terminal.return_value).toBe('{"partial":true}')
    expect(terminal.error).toBe('terminal error')
    expect(terminal.totals).toEqual({
      token_count: 50,
      tool_count: 5,
      agent_count: 2,
      running_count: 0,
      done_count: 2,
      replayed_count: 1,
      live_count: 1,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancel reports exact whole-run and child-agent hits and misses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-cancel-'))
  try {
    const { ports } = mockPorts(dir, new Map())
    ports.taskRegistrar.getActive = runId =>
      runId === 'active'
        ? {
            runId,
            taskId: 'w-active',
            instanceId: 4,
            signal: new AbortController().signal,
          }
        : undefined
    ports.taskRegistrar.kill = runId => runId === 'active'
    ports.taskRegistrar.killAgent = (runId, agentId) =>
      runId === 'active' && agentId === 2
    const tool = createWorkflowTool(ports)

    const runHit = JSON.parse(
      (
        await tool.call(
          { operation: 'cancel', runId: 'active' },
          undefined,
          undefined,
          undefined,
        )
      ).data.output,
    )
    const agentHit = JSON.parse(
      (
        await tool.call(
          { operation: 'cancel', runId: 'active', agentId: 2 },
          undefined,
          undefined,
          undefined,
        )
      ).data.output,
    )
    const agentMiss = JSON.parse(
      (
        await tool.call(
          { operation: 'cancel', runId: 'active', agentId: 8 },
          undefined,
          undefined,
          undefined,
        )
      ).data.output,
    )

    expect(runHit).toMatchObject({ target: 'run', hit: true })
    expect(agentHit).toMatchObject({
      target: 'agent',
      agent_id: 2,
      supported: true,
      hit: true,
    })
    expect(agentMiss).toMatchObject({
      target: 'agent',
      agent_id: 8,
      supported: true,
      hit: false,
    })
    expect(agentMiss.message).toMatch(/already finished/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a host without single-agent cancellation says so instead of reporting no match', async () => {
  // Both used to come back as `hit: false`, which told the model to hunt for the
  // right agentId on a host that can never honor one — the answer is "cancel the
  // whole run instead".
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-cancel-unsupported-'))
  try {
    const { ports } = mockPorts(dir, new Map())
    ports.taskRegistrar.getActive = runId => ({
      runId,
      taskId: 'w-active',
      instanceId: 4,
      signal: new AbortController().signal,
    })
    expect(ports.taskRegistrar.killAgent).toBeUndefined()
    const tool = createWorkflowTool(ports)

    const result = JSON.parse(
      (
        await tool.call(
          { operation: 'cancel', runId: 'active', agentId: 2 },
          undefined,
          undefined,
          undefined,
        )
      ).data.output,
    )

    expect(result).toMatchObject({
      target: 'agent',
      agent_id: 2,
      supported: false,
      hit: false,
    })
    expect(result.message).toMatch(/does not support/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the loser of a concurrent resume does not overwrite the winner script hash', async () => {
  // Both callers reach the hash comparison; only one gets disposition 'created' and
  // only that one's script actually runs. Recording before the gate let the loser
  // stamp the run with a script that never executed, and the winner's own
  // checkpoints then failed the next resume's identity check.
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-race-hash-'))
  try {
    const { ports } = mockPorts(dir, new Map())
    const tool = createWorkflowTool(ports)
    await tool.call(
      { script: `return agent('winner')`, resumeFromRunId: 'run-x' },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(resolve => setTimeout(resolve, 30))
    const hashPath = join(
      dir,
      '.occ',
      'workflow-runs',
      'run-x',
      'script.sha256',
    )
    const winnerHash = await readFile(hashPath, 'utf-8')

    // Second caller: no live binding to short-circuit on, but registration reports
    // the canonical owner already exists.
    ports.taskRegistrar.register = () => ({
      runId: 'run-x',
      signal: new AbortController().signal,
      taskId: 'w-wrapper',
      disposition: 'existing',
    })
    const loser = await tool.call(
      { script: `return agent('loser')`, resumeFromRunId: 'run-x' },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(loser.data.output).toContain('already running')
    expect(await readFile(hashPath, 'utf-8')).toBe(winnerHash)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a completed run stays completed when terminal bookkeeping throws', async () => {
  // taskRegistrar.complete persists state.json and evicts the wrapper task. It used
  // to share a catch with the engine, so a failed state write re-reported the run as
  // run_done {status:'failed'} — the model was told its workflow failed because a
  // file could not be written.
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-bookkeeping-'))
  try {
    const { ports, events } = mockPorts(
      dir,
      new Map([
        ['x', { kind: 'ok', output: '42', usage: { outputTokens: 1 } }],
      ]),
    )
    ports.taskRegistrar.complete = () => {
      throw new Error('state.json write failed')
    }
    const tool = createWorkflowTool(ports)
    await tool.call(
      { script: `return agent('x')` },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(resolve => setTimeout(resolve, 50))

    const terminal = events.filter(event => event.type === 'run_done')
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ status: 'completed' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('detached rejection emits a queryable terminal failure before failing the wrapper', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-detached-fail-'))
  try {
    const { ports, events, runStatus } = mockPorts(
      dir,
      new Map([['x', { kind: 'ok', output: 'x', usage: { outputTokens: 1 } }]]),
    )
    ports.taskRegistrar.register = () => ({
      runId: 'run-x',
      taskId: 'w-detached',
      instanceId: 14,
      signal: new AbortController().signal,
    })
    ports.journalStore.append = async () => {
      throw new Error('journal unavailable')
    }
    ports.journalStore.read = async () => {
      throw new Error('journal unavailable')
    }
    const tool = createWorkflowTool(ports)

    await tool.call(
      { script: `return agent('x')` },
      undefined,
      undefined,
      undefined,
    )
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(events.at(-1)).toMatchObject({
      type: 'run_done',
      runId: 'run-x',
      workflowName: 'workflow',
      taskId: 'w-detached',
      instanceId: 14,
      status: 'failed',
      error: 'journal unavailable',
    })
    expect(runStatus.get('run-x')).toBe('failed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scriptPath with control characters is refused before registration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const scriptFile = join(dir, 'sneaky.ts')
    // Schema refinement cannot see this: the model only sent a path.
    await writeFile(scriptFile, `return agent('compute')\r\x1b[2K// hidden`)
    const { ports, runStatus } = mockPorts(dir, new Map())
    const tool = createWorkflowTool(ports)
    const res = await tool.call(
      { scriptPath: scriptFile },
      undefined,
      undefined,
      undefined,
    )
    expect(res.data.output).toContain('control characters')
    expect(res.data.output).toContain('sneaky.ts')
    expect(res.data.output).not.toContain('run_id')
    await new Promise(r => {
      setTimeout(r, 50)
    })
    expect(runStatus.size).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scriptPath with multi-byte UTF-8 content still launches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-tool-'))
  try {
    const scriptFile = join(dir, 'unicode.ts')
    await writeFile(scriptFile, `// 中文注释 🚀\nreturn agent('compute')`)
    const { ports, runStatus } = mockPorts(
      dir,
      new Map([
        ['compute', { kind: 'ok', output: 'done', usage: { outputTokens: 1 } }],
      ]),
    )
    const tool = createWorkflowTool(ports)
    const res = await tool.call(
      { scriptPath: scriptFile },
      undefined,
      undefined,
      undefined,
    )
    expect(res.data.output).toContain('run_id')
    await new Promise(r => {
      setTimeout(r, 50)
    })
    expect(runStatus.get('run-x')).toBe('completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
