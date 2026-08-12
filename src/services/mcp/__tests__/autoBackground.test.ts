/**
 * Auto-backgrounding of slow MCP tool calls.
 *
 * The two things that actually matter here are hard to see by reading the code: that a
 * backgrounded call keeps running after the *parent* controller aborts (otherwise
 * "moved to the background" is a lie), and that the threshold policy refuses in exactly
 * the situations where a background task would be useless or wrong.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const {
  attachDetachableAbortRelay,
  callMcpToolWithAutoBackground,
  DEFAULT_MCP_AUTO_BACKGROUND_MS,
  getMcpAutoBackgroundMs,
  MAX_MCP_AUTO_BACKGROUND_MS,
  mcpBackgroundedMessage,
  mcpContentToText,
} = await import('../autoBackground.js')

const ENV_KEYS = [
  'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  'CLAUDE_AUTO_BACKGROUND_TASKS',
] as const

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('getMcpAutoBackgroundMs', () => {
  test('defaults to the upstream two-minute threshold for an ordinary server', () => {
    expect(getMcpAutoBackgroundMs({ type: 'stdio' })).toBe(
      DEFAULT_MCP_AUTO_BACKGROUND_MS,
    )
    expect(DEFAULT_MCP_AUTO_BACKGROUND_MS).toBe(120_000)
  })

  test('refuses for IDE transports — their calls answer a live editor interaction', () => {
    expect(getMcpAutoBackgroundMs({ type: 'sse-ide' })).toBe(0)
    expect(getMcpAutoBackgroundMs({ type: 'ws-ide' })).toBe(0)
  })

  test('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS wins over the env override', () => {
    process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
    process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '5000'
    expect(getMcpAutoBackgroundMs({ type: 'stdio' })).toBe(0)
  })

  test('non-interactive sessions stay blocking unless they opt in', () => {
    expect(
      getMcpAutoBackgroundMs(
        { type: 'stdio' },
        { isNonInteractiveSession: true },
      ),
    ).toBe(0)
    process.env.CLAUDE_AUTO_BACKGROUND_TASKS = '1'
    expect(
      getMcpAutoBackgroundMs(
        { type: 'stdio' },
        { isNonInteractiveSession: true },
      ),
    ).toBe(DEFAULT_MCP_AUTO_BACKGROUND_MS)
  })

  test('env override is honoured, clamped, and 0 disables', () => {
    process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '2500'
    expect(getMcpAutoBackgroundMs({ type: 'stdio' })).toBe(2500)
    process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '0'
    expect(getMcpAutoBackgroundMs({ type: 'stdio' })).toBe(0)
    process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '-5'
    expect(getMcpAutoBackgroundMs({ type: 'stdio' })).toBe(0)
    process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '999999999999'
    expect(getMcpAutoBackgroundMs({ type: 'stdio' })).toBe(
      MAX_MCP_AUTO_BACKGROUND_MS,
    )
  })

  test('a non-numeric override falls back to the default, never to "background instantly"', () => {
    process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = 'soon'
    expect(getMcpAutoBackgroundMs({ type: 'stdio' })).toBe(
      DEFAULT_MCP_AUTO_BACKGROUND_MS,
    )
  })

  test('an unknown/absent transport is backgroundable (stdio is the default shape)', () => {
    expect(getMcpAutoBackgroundMs(undefined)).toBe(
      DEFAULT_MCP_AUTO_BACKGROUND_MS,
    )
  })
})

describe('attachDetachableAbortRelay', () => {
  test('relays until detached, then stops', () => {
    const parent = new AbortController()
    const child = new AbortController()
    const detach = attachDetachableAbortRelay(parent, child)
    detach()
    parent.abort()
    expect(child.signal.aborted).toBe(false)
  })

  test('relays an abort that arrives before detach', () => {
    const parent = new AbortController()
    const child = new AbortController()
    attachDetachableAbortRelay(parent, child)
    parent.abort()
    expect(child.signal.aborted).toBe(true)
  })

  test('an already-aborted parent aborts the child immediately', () => {
    const parent = new AbortController()
    parent.abort()
    const child = new AbortController()
    attachDetachableAbortRelay(parent, child)
    expect(child.signal.aborted).toBe(true)
  })

  test('detach is idempotent', () => {
    const parent = new AbortController()
    const child = new AbortController()
    const detach = attachDetachableAbortRelay(parent, child)
    detach()
    detach()
    parent.abort()
    expect(child.signal.aborted).toBe(false)
  })
})

type Harness = {
  registered: Array<{ id: string; description: string }>
  settled: Array<{ taskId: string; status: string; resultText: string }>
}

/**
 * The task registry and the notification queue are AppState/global machinery; this
 * suite is about the handoff itself, so both are supplied through the module's own
 * injection seam rather than mocked. No `mock.module` on a repo module means no
 * process-global residue for whatever file bun loads next.
 */
function harness(): Harness & {
  registerTask: (setAppState: unknown, opts: { description: string }) => string
  settleTask: (
    taskId: string,
    setAppState: unknown,
    info: { status: string; resultText: string },
  ) => void
} {
  const registered: Harness['registered'] = []
  const settled: Harness['settled'] = []
  return {
    registered,
    settled,
    registerTask: (_setAppState, opts) => {
      const id = `m${registered.length}`
      registered.push({ id, description: opts.description })
      return id
    },
    settleTask: (taskId, _setAppState, info) => {
      settled.push({ taskId, status: info.status, resultText: info.resultText })
    },
  }
}

function baseOptions(
  h: ReturnType<typeof harness>,
  overrides: Record<string, unknown> = {},
) {
  return {
    serverName: 'slowsrv',
    toolName: 'crunch',
    parentAbortController: new AbortController(),
    autoBackgroundMs: 10,
    setAppState: () => {},
    registerTask: h.registerTask,
    settleTask: h.settleTask,
    describeResult: (value: { content: string }) => value.content,
    buildBackgroundedResult: ({
      taskId,
      elapsedSeconds,
    }: {
      taskId: string
      elapsedSeconds: number
    }) => ({
      content: mcpBackgroundedMessage(
        'slowsrv - crunch',
        taskId,
        elapsedSeconds,
      ),
    }),
    ...overrides,
  }
}

describe('callMcpToolWithAutoBackground', () => {
  test('a fast call returns its real result and registers nothing', async () => {
    const h = harness()
    const result = await callMcpToolWithAutoBackground({
      ...baseOptions(h, { autoBackgroundMs: 10_000 }),
      run: async () => ({ content: 'fast answer' }),
    } as never)
    expect(result).toEqual({ content: 'fast answer' })
    expect(h.registered).toEqual([])
  })

  test('a rejecting call propagates its error rather than being backgrounded', async () => {
    const h = harness()
    await expect(
      callMcpToolWithAutoBackground({
        ...baseOptions(h, { autoBackgroundMs: 10_000 }),
        run: async () => {
          throw new Error('server said no')
        },
      } as never),
    ).rejects.toThrow('server said no')
    expect(h.registered).toEqual([])
  })

  test('a slow call is handed off, and the placeholder names the task and how to stop it', async () => {
    const h = harness()
    let release: (v: { content: string }) => void = () => {}
    const result = (await callMcpToolWithAutoBackground({
      ...baseOptions(h),
      run: async () =>
        new Promise<{ content: string }>(resolve => {
          release = resolve
        }),
    } as never)) as { content: string }

    expect(h.registered).toHaveLength(1)
    expect(h.registered[0]!.description).toBe('slowsrv · crunch')
    expect(result.content).toContain('moved to the background as task m0')
    expect(result.content).toContain('TaskStop with task_id "m0"')
    expect(result.content).toContain('does not survive exiting this session')

    release({ content: 'late answer' })
    await new Promise(r => setTimeout(r, 10))
    expect(h.settled).toEqual([
      { taskId: 'm0', status: 'completed', resultText: 'late answer' },
    ])
  })

  test('the backgrounded call survives the parent abort — the whole point of the handoff', async () => {
    const h = harness()
    let observed: AbortSignal | undefined
    const parentAbortController = new AbortController()
    let release: (v: { content: string }) => void = () => {}
    await callMcpToolWithAutoBackground({
      ...baseOptions(h, { parentAbortController }),
      run: async (signal: AbortSignal) => {
        observed = signal
        return new Promise<{ content: string }>(resolve => {
          release = resolve
        })
      },
    } as never)

    parentAbortController.abort()
    expect(observed?.aborted).toBe(false)
    release({ content: 'done anyway' })
  })

  test('a slow call whose parent aborts before the threshold is cancelled, not backgrounded', async () => {
    const h = harness()
    const parentAbortController = new AbortController()
    const promise = callMcpToolWithAutoBackground({
      ...baseOptions(h, { parentAbortController, autoBackgroundMs: 10_000 }),
      run: (signal: AbortSignal) =>
        new Promise<{ content: string }>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    } as never)
    parentAbortController.abort()
    await expect(promise).rejects.toThrow('aborted')
    expect(h.registered).toEqual([])
  })

  test('a pending elicitation defers the handoff — blocked on the user is not slow', async () => {
    const h = harness()
    let pending = true
    let release: (v: { content: string }) => void = () => {}
    const promise = callMcpToolWithAutoBackground({
      ...baseOptions(h),
      hasPendingElicitation: () => pending,
      run: async () =>
        new Promise<{ content: string }>(resolve => {
          release = resolve
        }),
    } as never)

    await new Promise(r => setTimeout(r, 40))
    expect(h.registered).toEqual([])

    // User answers; the next timer tick may hand it off.
    pending = false
    await promise
    expect(h.registered).toHaveLength(1)
    release({ content: 'after elicitation' })
  })

  test('a backgrounded call that later fails settles as failed with the error message', async () => {
    const h = harness()
    let fail: (e: Error) => void = () => {}
    await callMcpToolWithAutoBackground({
      ...baseOptions(h),
      run: async () =>
        new Promise<{ content: string }>((_resolve, reject) => {
          fail = reject
        }),
    } as never)
    fail(new Error('upstream exploded'))
    await new Promise(r => setTimeout(r, 10))
    expect(h.settled).toEqual([
      { taskId: 'm0', status: 'failed', resultText: 'upstream exploded' },
    ])
  })

  test('a throwing describeResult still settles the task as completed', async () => {
    const h = harness()
    let release: (v: { content: string }) => void = () => {}
    await callMcpToolWithAutoBackground({
      ...baseOptions(h, {
        describeResult: () => {
          throw new Error('render blew up')
        },
      }),
      run: async () =>
        new Promise<{ content: string }>(resolve => {
          release = resolve
        }),
    } as never)
    release({ content: 'x' })
    await new Promise(r => setTimeout(r, 10))
    expect(h.settled[0]!.status).toBe('completed')
    expect(h.settled[0]!.resultText).toContain('could not be rendered')
  })
})

describe('mcpContentToText', () => {
  test('passes strings through and flattens text blocks', () => {
    expect(mcpContentToText('plain')).toBe('plain')
    expect(mcpContentToText(undefined)).toBe('')
    expect(
      mcpContentToText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ] as never),
    ).toBe('a\nb')
  })

  test('non-text blocks become a labelled placeholder rather than vanishing', () => {
    expect(
      mcpContentToText([
        { type: 'text', text: 'caption' },
        {
          type: 'image',
          source: { type: 'base64', data: '', media_type: 'image/png' },
        },
      ] as never),
    ).toBe('caption\n[image content omitted]')
  })
})
