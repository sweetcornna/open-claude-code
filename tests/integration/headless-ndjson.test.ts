/**
 * Characterization tests for the headless NDJSON stream — the wire format
 * behind `--print --input-format stream-json --output-format stream-json`.
 *
 * WHY THIS FILE EXISTS
 * `src/cli/print.ts` is ~5.6k lines and is about to be split. Everything a
 * headless SDK host sees is one JSON object per line on stdout, plus one JSON
 * object per line on stdin. This file pins that observable contract so the
 * split can be verified as behaviour-preserving.
 *
 * WHAT IS DRIVEN, AND WHY NOT MORE
 * `runHeadless()` is print.ts's only exported entry into the stream, and it is
 * not drivable from a test: it subscribes settings watchers, starts a GC
 * timer, initializes GrowthBook, performs network-backed eligibility checks,
 * and finishes by calling `gracefulShutdownSync()` (which sets
 * process.exitCode and schedules a real process teardown). The repo's only
 * end-to-end CLI test (tests/integration/autonomy-lifecycle-user-flow.test.ts)
 * works around this by spawning the *built* `dist/cli.js`, lazily running a
 * full build when it is stale — far past this suite's runtime budget, and it
 * still could not reach the API loop without a live model.
 *
 * So this file drives the layers that actually produce and consume the NDJSON,
 * in-process, with no `mock.module` at all (hence no cross-file mock
 * pollution):
 *   - `buildSystemInitMessage()`   — the real producer of stdout event #1
 *   - `StructuredIO`               — the real stdin parser and stdout writer
 *     (`getStructuredIO()` in print.ts is a thin factory around it)
 *   - `ndjsonSafeStringify`        — the real line serializer
 *   - the production zod schemas in `src/entrypoints/sdk/*Schemas.ts`, used as
 *     the contract oracle so the fixtures below are schema-verified rather
 *     than self-asserted.
 *
 * NOT COVERED (documented, not faked): the outbound `control_response` for
 * `set_permission_mode` is built by `handleSetPermissionMode`, which is
 * module-private in print.ts and only reachable through `runHeadless`. Only
 * the inbound half of that exchange is pinned here. See the last describe
 * block.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ndjsonSafeStringify } from 'src/cli/ndjsonSafeStringify.js'
import { StructuredIO } from 'src/cli/structuredIO.js'
import {
  SDKControlCancelRequestSchema,
  SDKControlRequestSchema,
  SDKControlSetPermissionModeRequestSchema,
  StdoutMessageSchema,
} from 'src/entrypoints/sdk/controlSchemas.js'
import {
  SDKAssistantMessageSchema,
  SDKResultMessageSchema,
  SDKSystemMessageSchema,
} from 'src/entrypoints/sdk/coreSchemas.js'
import type { StdinMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { buildSystemInitMessage } from 'src/utils/messages/systemInit.js'

// MACRO is a build-time define injected by `bun --define` (scripts/defines.ts).
// `buildSystemInitMessage` reads MACRO.VERSION, so the bare identifier has to
// resolve under `bun test`. Guarded so this stays idempotent when another test
// file in the same process has already installed it.
if (typeof (globalThis as { MACRO?: unknown }).MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: '0.0.0-test',
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Captures what `StructuredIO.write()` puts on stdout. `write()` goes through
 * `writeToStdout` -> `process.stdout.write`, so patching that one method is
 * enough and avoids mocking `src/utils/process.ts` (which every other suite
 * shares).
 */
function captureStdout(): {
  lines: () => string[]
  writeCount: () => number
  restore: () => void
} {
  const original = process.stdout.write.bind(process.stdout)
  const chunks: string[] = []
  ;(process.stdout as unknown as { write: unknown }).write = (
    chunk: unknown,
  ) => {
    chunks.push(String(chunk))
    return true
  }
  return {
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(line => line !== ''),
    writeCount: () => chunks.length,
    restore: () => {
      ;(process.stdout as unknown as { write: unknown }).write = original
    },
  }
}

/** A pushable stdin stream, so tests can interleave reads and writes. */
function pushableInput(): {
  push: (line: string) => void
  close: () => void
  [Symbol.asyncIterator]: () => AsyncGenerator<string>
} {
  const queue: string[] = []
  let wake: (() => void) | null = null
  let closed = false
  return {
    push(line: string) {
      queue.push(line)
      wake?.()
      wake = null
    },
    close() {
      closed = true
      wake?.()
      wake = null
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as string
        if (closed) return
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    },
  }
}

function fromLines(...lines: string[]): AsyncIterable<string> {
  return (async function* () {
    for (const line of lines) yield line
  })()
}

function ndjson(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

async function collectInput(
  io: StructuredIO,
): Promise<Array<StdinMessage | Record<string, unknown>>> {
  const seen: Array<StdinMessage | Record<string, unknown>> = []
  for await (const message of io.structuredInput) {
    seen.push(message as StdinMessage)
  }
  return seen
}

/** Nothing on stdin; used when a test only exercises the write direction. */
function writeOnlyIO(): StructuredIO {
  return new StructuredIO(fromLines())
}

function eventLabel(event: Record<string, unknown>): string {
  return typeof event.subtype === 'string'
    ? `${String(event.type)}/${event.subtype}`
    : String(event.type)
}

// Volatile fields the SDK host is expected to ignore. Stripped before any
// shape comparison so the fixtures do not depend on clock, PID or checkout.
const VOLATILE_KEYS = new Set([
  'uuid',
  'session_id',
  'cwd',
  'duration_ms',
  'duration_api_ms',
  'total_cost_usd',
  'claude_code_version',
])

function normalizeEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    out[key] = VOLATILE_KEYS.has(key) ? `<${key}>` : value
  }
  return out
}

// ─── Fixture 1: plain prompt -> assistant text -> result ──────────────

const ASSISTANT_TEXT_EVENT = {
  type: 'assistant',
  message: {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-test-model',
    content: [{ type: 'text', text: 'Hello from the model.' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  },
  parent_tool_use_id: null,
  uuid: '11111111-1111-4111-8111-111111111111',
  session_id: 'session-under-test',
} as const

const RESULT_SUCCESS_EVENT = {
  type: 'result',
  subtype: 'success',
  duration_ms: 1234,
  duration_api_ms: 1000,
  is_error: false,
  num_turns: 1,
  result: 'Hello from the model.',
  stop_reason: 'end_turn',
  total_cost_usd: 0.0001,
  usage: { input_tokens: 10, output_tokens: 5 },
  modelUsage: {},
  permission_denials: [],
  uuid: '22222222-2222-4222-8222-222222222222',
  session_id: 'session-under-test',
} as const

// ─── system/init: the first event on the stdout stream ────────────────

describe('Headless NDJSON: system/init event', () => {
  let priorApiKey: string | undefined

  beforeAll(() => {
    // getAnthropicApiKeyWithSource() throws under NODE_ENV=test when neither
    // an API key nor an OAuth token is present, and buildSystemInitMessage
    // calls it to populate apiKeySource. Saved and restored so the env stays
    // exactly as this file found it (bun runs test files in one process).
    priorApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-headless-ndjson-test'
  })

  afterAll(() => {
    if (priorApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = priorApiKey
    }
  })

  function buildInit() {
    return buildSystemInitMessage({
      tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Agent' }],
      mcpClients: [{ name: 'my-server', type: 'connected' }],
      model: 'claude-test-model',
      permissionMode: 'default',
      commands: [
        { name: 'help' },
        { name: 'internal-only', userInvocable: false },
      ],
      agents: [{ agentType: 'general-purpose' }],
      skills: [{ name: 'pdf' }, { name: 'hidden-skill', userInvocable: false }],
      plugins: [
        { name: 'my-plugin', path: '/plugins/my-plugin', source: 'local' },
      ],
      fastMode: undefined,
    }) as unknown as Record<string, unknown>
  }

  test('is a system message with subtype init', () => {
    const init = buildInit()
    expect(init.type).toBe('system')
    expect(init.subtype).toBe('init')
  })

  test('carries exactly the documented set of session-metadata keys', () => {
    expect(Object.keys(buildInit()).sort()).toEqual([
      'agents',
      'apiKeySource',
      'betas',
      'claude_code_version',
      'cwd',
      'fast_mode_state',
      'mcp_servers',
      'model',
      'output_style',
      'permissionMode',
      'plugins',
      'session_id',
      'skills',
      'slash_commands',
      'subtype',
      'tools',
      'type',
      'uuid',
    ])
  })

  test('translates the Agent tool back to its legacy wire name Task', () => {
    // sdkCompatToolName: the tool was renamed Task -> Agent internally, but
    // init/result keep emitting 'Task' until the next minor.
    expect(buildInit().tools).toEqual(['Bash', 'Read', 'Task'])
  })

  test('omits commands and skills that are not user-invocable', () => {
    const init = buildInit()
    expect(init.slash_commands).toEqual(['help'])
    expect(init.skills).toEqual(['pdf'])
  })

  test('maps mcp clients to {name, status} and plugins to {name, path, source}', () => {
    const init = buildInit()
    expect(init.mcp_servers).toEqual([
      { name: 'my-server', status: 'connected' },
    ])
    expect(init.plugins).toEqual([
      { name: 'my-plugin', path: '/plugins/my-plugin', source: 'local' },
    ])
  })

  test('stamps a fresh uuid on every init message', () => {
    const first = buildInit()
    const second = buildInit()
    expect(String(first.uuid)).toMatch(UUID_RE)
    expect(first.uuid).not.toBe(second.uuid)
  })

  test('reports the build-time version and a string session id', () => {
    const init = buildInit()
    expect(init.claude_code_version).toBe(
      (globalThis as unknown as { MACRO: { VERSION: string } }).MACRO.VERSION,
    )
    expect(typeof init.session_id).toBe('string')
    expect(String(init.session_id).length).toBeGreaterThan(0)
  })

  test('matches the published SDKSystemMessageSchema once apiKeySource is normalized', () => {
    const init = buildInit()
    // Known divergence, pinned deliberately: with ANTHROPIC_API_KEY set,
    // getAnthropicApiKeyWithSource() reports the source as the literal
    // 'ANTHROPIC_API_KEY', which is NOT one of ApiKeySourceSchema's values
    // (user | project | org | temporary | oauth). Every other field does
    // satisfy the published schema.
    expect(init.apiKeySource).toBe('ANTHROPIC_API_KEY')
    expect(
      SDKSystemMessageSchema().safeParse({ ...init, apiKeySource: 'user' })
        .success,
    ).toBe(true)
  })
})

// ─── stdout: one JSON object per line ─────────────────────────────────

describe('Headless NDJSON: stdout line framing', () => {
  test('write() emits exactly one newline-terminated line per message', async () => {
    const io = writeOnlyIO()
    const capture = captureStdout()
    try {
      await io.write(ASSISTANT_TEXT_EVENT as never)
      await io.write(RESULT_SUCCESS_EVENT as never)
    } finally {
      capture.restore()
    }
    expect(capture.writeCount()).toBe(2)
    expect(capture.lines()).toHaveLength(2)
  })

  test('newlines inside message content never split the line', async () => {
    const io = writeOnlyIO()
    const capture = captureStdout()
    try {
      await io.write({
        type: 'system',
        subtype: 'status',
        status: 'first\nsecond\r\nthird',
        uuid: '33333333-3333-4333-8333-333333333333',
        session_id: 's',
      } as never)
    } finally {
      capture.restore()
    }
    const lines = capture.lines()
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string).status).toBe('first\nsecond\r\nthird')
  })

  test('escapes U+2028 / U+2029 so a JS line-splitting receiver cannot break a line', () => {
    // JSON.stringify emits these two raw (valid JSON), so any receiver that
    // splits on JavaScript line-terminator semantics would cut a line in half.
    const LINE_SEPARATOR = '\u2028'
    const PARAGRAPH_SEPARATOR = '\u2029'
    const text = `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`
    const serialized = ndjsonSafeStringify({ text })
    expect(serialized).not.toContain(LINE_SEPARATOR)
    expect(serialized).not.toContain(PARAGRAPH_SEPARATOR)
    expect(serialized).toContain('\\u2028')
    expect(serialized).toContain('\\u2029')
    expect(JSON.parse(serialized).text).toBe(text)
  })

  test('drops undefined-valued fields rather than emitting null', () => {
    const parsed = JSON.parse(
      ndjsonSafeStringify({ kept: 1, dropped: undefined, nulled: null }),
    )
    expect('dropped' in parsed).toBe(false)
    expect(parsed.nulled).toBeNull()
    expect(parsed.kept).toBe(1)
  })
})

// ─── Fixture 1 end-to-end shape ───────────────────────────────────────

describe('Headless NDJSON: fixture 1 (prompt -> assistant text -> result)', () => {
  let priorApiKey: string | undefined

  beforeAll(() => {
    priorApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-headless-ndjson-test'
  })

  afterAll(() => {
    if (priorApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = priorApiKey
    }
  })

  async function emitTurn(): Promise<Array<Record<string, unknown>>> {
    const init = buildSystemInitMessage({
      tools: [{ name: 'Bash' }],
      mcpClients: [],
      model: 'claude-test-model',
      permissionMode: 'default',
      commands: [],
      agents: [],
      skills: [],
      plugins: [],
      fastMode: undefined,
    })
    const io = writeOnlyIO()
    const capture = captureStdout()
    try {
      await io.write(init as never)
      await io.write(ASSISTANT_TEXT_EVENT as never)
      await io.write(RESULT_SUCCESS_EVENT as never)
    } finally {
      capture.restore()
    }
    return capture
      .lines()
      .map(line => JSON.parse(line) as Record<string, unknown>)
  }

  test('emits the system/init -> assistant -> result/success type sequence', async () => {
    const events = await emitTurn()
    expect(events.map(eventLabel)).toEqual([
      'system/init',
      'assistant',
      'result/success',
    ])
  })

  test('every emitted line is a standalone, parseable stdout message', async () => {
    const events = await emitTurn()
    for (const event of events) {
      const candidate =
        event.type === 'system' && event.subtype === 'init'
          ? { ...event, apiKeySource: 'user' }
          : event
      expect(StdoutMessageSchema().safeParse(candidate).success).toBe(true)
    }
  })

  test('the assistant event keeps the raw API message under `message`', async () => {
    const [, assistant] = await emitTurn()
    const normalized = normalizeEvent(assistant as Record<string, unknown>)
    expect(Object.keys(normalized).sort()).toEqual([
      'message',
      'parent_tool_use_id',
      'session_id',
      'type',
      'uuid',
    ])
    expect(normalized.parent_tool_use_id).toBeNull()
    expect(normalized.uuid).toBe('<uuid>')
    expect(SDKAssistantMessageSchema().safeParse(assistant).success).toBe(true)
  })

  test('the result event carries the turn accounting fields', async () => {
    const [, , result] = await emitTurn()
    const normalized = normalizeEvent(result as Record<string, unknown>)
    expect(Object.keys(normalized).sort()).toEqual([
      'duration_api_ms',
      'duration_ms',
      'is_error',
      'modelUsage',
      'num_turns',
      'permission_denials',
      'result',
      'session_id',
      'stop_reason',
      'subtype',
      'total_cost_usd',
      'type',
      'usage',
      'uuid',
    ])
    expect(normalized.is_error).toBe(false)
    expect(normalized.duration_ms).toBe('<duration_ms>')
    expect(SDKResultMessageSchema().safeParse(result).success).toBe(true)
  })
})

// ─── stdin: --input-format stream-json ────────────────────────────────

describe('Headless NDJSON: stdin stream-json parsing', () => {
  test('yields a user turn for a plain prompt line, unchanged', async () => {
    const prompt = {
      type: 'user',
      message: { role: 'user', content: 'what is 2 + 2?' },
      parent_tool_use_id: null,
      uuid: '',
      session_id: '',
    }
    const seen = await collectInput(new StructuredIO(fromLines(ndjson(prompt))))
    expect(seen).toEqual([prompt])
  })

  test('silently drops keep_alive frames', async () => {
    const seen = await collectInput(
      new StructuredIO(
        fromLines(
          ndjson({ type: 'keep_alive' }),
          ndjson({ type: 'user', message: { role: 'user', content: 'hi' } }),
        ),
      ),
    )
    expect(seen.map(m => m.type)).toEqual(['user'])
  })

  test('drops unknown message types instead of failing the stream', async () => {
    const seen = await collectInput(
      new StructuredIO(
        fromLines(
          ndjson({ type: 'not_a_real_message_type' }),
          ndjson({ type: 'user', message: { role: 'user', content: 'hi' } }),
        ),
      ),
    )
    expect(seen.map(m => m.type)).toEqual(['user'])
  })

  test('skips blank lines produced by doubled newlines', async () => {
    const seen = await collectInput(
      new StructuredIO(
        fromLines(
          `\n${ndjson({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`,
        ),
      ),
    )
    expect(seen.map(m => m.type)).toEqual(['user'])
  })

  test('passes assistant and system frames through', async () => {
    const seen = await collectInput(
      new StructuredIO(
        fromLines(
          ndjson({ type: 'assistant', message: { role: 'assistant' } }),
          ndjson({ type: 'system', subtype: 'anything' }),
        ),
      ),
    )
    expect(seen.map(m => m.type)).toEqual(['assistant', 'system'])
  })

  test('splits several messages delivered in a single chunk, in order', async () => {
    const chunk =
      ndjson({ type: 'user', message: { role: 'user', content: 'one' } }) +
      ndjson({ type: 'user', message: { role: 'user', content: 'two' } }) +
      ndjson({ type: 'user', message: { role: 'user', content: 'three' } })
    const seen = await collectInput(new StructuredIO(fromLines(chunk)))
    expect(
      seen.map(m => (m as { message: { content: string } }).message.content),
    ).toEqual(['one', 'two', 'three'])
  })

  test('buffers a message split across two chunks until its newline arrives', async () => {
    const line = ndjson({
      type: 'user',
      message: { role: 'user', content: 'split across chunks' },
    })
    const half = Math.floor(line.length / 2)
    const seen = await collectInput(
      new StructuredIO(fromLines(line.slice(0, half), line.slice(half))),
    )
    expect(seen).toHaveLength(1)
    expect((seen[0] as { message: { content: string } }).message.content).toBe(
      'split across chunks',
    )
  })

  test('processes a trailing line that has no terminating newline', async () => {
    const seen = await collectInput(
      new StructuredIO(
        fromLines(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: 'no trailing newline' },
          }),
        ),
      ),
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.type).toBe('user')
  })

  test('prependUserMessage injects a full SDKUserMessage envelope ahead of stdin', async () => {
    const io = new StructuredIO(
      fromLines(
        ndjson({
          type: 'user',
          message: { role: 'user', content: 'from stdin' },
        }),
      ),
    )
    io.prependUserMessage('injected first')
    const seen = await collectInput(io)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual({
      type: 'user',
      content: 'injected first',
      uuid: '',
      session_id: '',
      message: { role: 'user', content: 'injected first' },
      parent_tool_use_id: null,
    })
    expect((seen[1] as { message: { content: string } }).message.content).toBe(
      'from stdin',
    )
  })
})

// ─── Fixture 2: tool_use -> can_use_tool control exchange ─────────────

/**
 * When the assistant emits a tool_use that is not pre-approved, headless mode
 * does not prompt a TTY — it writes a `control_request` with subtype
 * `can_use_tool` and waits for the host's `control_response` on stdin. This is
 * the tool-related event sequence a `--print` SDK host observes.
 */
describe('Headless NDJSON: fixture 2 (tool_use permission control exchange)', () => {
  const TOOL = {
    name: 'Read',
    userFacingName: () => 'Read',
  } as unknown as Parameters<ReturnType<StructuredIO['createCanUseTool']>>[0]

  const TOOL_INPUT = { file_path: '/tmp/example.txt' }

  function toolUseContext(): Parameters<
    ReturnType<StructuredIO['createCanUseTool']>
  >[2] {
    return {
      abortController: new AbortController(),
      getAppState: () => ({
        toolPermissionContext: {
          mode: 'default',
          additionalWorkingDirectories: new Set(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: false,
        },
      }),
    } as unknown as Parameters<ReturnType<StructuredIO['createCanUseTool']>>[2]
  }

  /**
   * Starts a permission request and returns the emitted control_request plus a
   * `respond` helper that feeds the host's control_response back over stdin.
   *
   * `forceDecision: ask` is the documented way to reach the SDK prompt without
   * consulting on-disk permission rules, so the exchange stays hermetic.
   */
  async function startPermissionExchange() {
    const input = pushableInput()
    const io = new StructuredIO(input)
    const yielded: string[] = []
    const drained = (async () => {
      for await (const message of io.structuredInput) yielded.push(message.type)
    })()

    const decision = io.createCanUseTool()(
      TOOL,
      TOOL_INPUT,
      toolUseContext(),
      { type: 'assistant' } as never,
      'toolu_fixture2',
      { behavior: 'ask', message: 'needs approval' } as never,
    )
    // Swallow rejections until the assertion awaits it.
    decision.catch(() => {})

    const outbound = io.outbound[Symbol.asyncIterator]()
    const first = await outbound.next()
    const request = JSON.parse(ndjsonSafeStringify(first.value)) as Record<
      string,
      unknown
    >

    return {
      io,
      request,
      yielded,
      pendingBeforeResponse: io.getPendingPermissionRequests().length,
      async respond(response: Record<string, unknown>) {
        input.push(
          ndjson({
            type: 'control_response',
            response: { request_id: request.request_id, ...response },
          }),
        )
        const result = await decision
        input.close()
        await drained
        return result
      },
    }
  }

  test('writes a can_use_tool control_request naming the tool and its input', async () => {
    const exchange = await startPermissionExchange()
    expect(exchange.request.type).toBe('control_request')
    expect(String(exchange.request.request_id)).toMatch(UUID_RE)
    expect(exchange.request.request).toEqual({
      subtype: 'can_use_tool',
      tool_name: 'Read',
      input: TOOL_INPUT,
      tool_use_id: 'toolu_fixture2',
    })
    await exchange.respond({
      subtype: 'success',
      response: { behavior: 'allow', updatedInput: TOOL_INPUT },
    })
  })

  test('the control_request satisfies the published SDKControlRequestSchema', async () => {
    const exchange = await startPermissionExchange()
    expect(SDKControlRequestSchema().safeParse(exchange.request).success).toBe(
      true,
    )
    await exchange.respond({
      subtype: 'success',
      response: { behavior: 'allow', updatedInput: TOOL_INPUT },
    })
  })

  test('the request is listed as pending until the host answers', async () => {
    const exchange = await startPermissionExchange()
    expect(exchange.pendingBeforeResponse).toBe(1)
    await exchange.respond({
      subtype: 'success',
      response: { behavior: 'allow', updatedInput: TOOL_INPUT },
    })
    expect(exchange.io.getPendingPermissionRequests()).toHaveLength(0)
  })

  test('an allow control_response resolves to an allow decision attributed to the prompt tool', async () => {
    const exchange = await startPermissionExchange()
    const decision = await exchange.respond({
      subtype: 'success',
      response: { behavior: 'allow', updatedInput: TOOL_INPUT },
    })
    expect(decision.behavior).toBe('allow')
    expect(
      (decision as { updatedInput: Record<string, unknown> }).updatedInput,
    ).toEqual(TOOL_INPUT)
    expect(
      (decision as { decisionReason: { type: string } }).decisionReason.type,
    ).toBe('permissionPromptTool')
  })

  test('a deny control_response resolves to a deny decision carrying the host message', async () => {
    const exchange = await startPermissionExchange()
    const decision = await exchange.respond({
      subtype: 'success',
      response: { behavior: 'deny', message: 'user said no' },
    })
    expect(decision.behavior).toBe('deny')
    expect((decision as { message: string }).message).toBe('user said no')
  })

  test('an error control_response degrades to a deny rather than throwing', async () => {
    const exchange = await startPermissionExchange()
    const decision = await exchange.respond({
      subtype: 'error',
      error: 'host exploded',
    })
    expect(decision.behavior).toBe('deny')
    expect((decision as { message: string }).message).toContain(
      'Tool permission request failed',
    )
  })

  test('the control_response is consumed by the transport, not replayed to the turn loop', async () => {
    const exchange = await startPermissionExchange()
    await exchange.respond({
      subtype: 'success',
      response: { behavior: 'allow', updatedInput: TOOL_INPUT },
    })
    expect(exchange.yielded).toEqual([])
  })
})

// ─── Fixture 3: control requests ──────────────────────────────────────

/**
 * Only the halves reachable without `runHeadless` are pinned here.
 *
 * NOT PINNED: the outbound `control_response` that answers a
 * `set_permission_mode` request. It is produced by `handleSetPermissionMode`
 * in src/cli/print.ts, which is module-private and only invoked from
 * `runHeadlessStreaming` (also module-private). Reaching it would require
 * either exporting it — a production change this lane may not make — or
 * booting `runHeadless`, which is not drivable in-process (see file header).
 */
describe('Headless NDJSON: fixture 3 (control requests)', () => {
  test('a set_permission_mode control_request reaches the turn loop intact', async () => {
    const request = {
      type: 'control_request',
      request_id: 'req-set-mode-1',
      request: { subtype: 'set_permission_mode', mode: 'plan' },
    }
    const seen = await collectInput(
      new StructuredIO(fromLines(ndjson(request))),
    )
    expect(seen).toEqual([request])
  })

  test('the inbound set_permission_mode frame matches the published schemas', () => {
    const request = {
      type: 'control_request',
      request_id: 'req-set-mode-2',
      request: { subtype: 'set_permission_mode', mode: 'acceptEdits' },
    }
    expect(SDKControlRequestSchema().safeParse(request).success).toBe(true)
    expect(
      SDKControlSetPermissionModeRequestSchema().safeParse(request.request)
        .success,
    ).toBe(true)
  })

  test('control_request without a `request` payload is rejected by the schema', () => {
    expect(
      SDKControlRequestSchema().safeParse({
        type: 'control_request',
        request_id: 'req-broken',
      }).success,
    ).toBe(false)
  })

  test('injectControlResponse resolves a pending request and cancels the host prompt', async () => {
    const input = pushableInput()
    const io = new StructuredIO(input)
    const drained = (async () => {
      for await (const _ of io.structuredInput) {
        // drain
      }
    })()

    const decision = io.createCanUseTool()(
      { name: 'Read', userFacingName: () => 'Read' } as never,
      { file_path: '/tmp/a' },
      {
        abortController: new AbortController(),
        getAppState: () => ({
          toolPermissionContext: {
            mode: 'default',
            additionalWorkingDirectories: new Set(),
            alwaysAllowRules: {},
            alwaysDenyRules: {},
            alwaysAskRules: {},
            isBypassPermissionsModeAvailable: false,
          },
        }),
      } as never,
      { type: 'assistant' } as never,
      'toolu_inject',
      { behavior: 'ask', message: 'needs approval' } as never,
    )
    decision.catch(() => {})

    const outbound = io.outbound[Symbol.asyncIterator]()
    const request = (await outbound.next()).value as { request_id: string }

    const capture = captureStdout()
    try {
      io.injectControlResponse({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
          response: {
            behavior: 'allow',
            updatedInput: { file_path: '/tmp/a' },
          },
        },
      } as never)
    } finally {
      capture.restore()
    }

    const written = capture.lines().map(line => JSON.parse(line))
    expect(written).toHaveLength(1)
    expect(written[0]).toEqual({
      type: 'control_cancel_request',
      request_id: request.request_id,
    })
    expect(SDKControlCancelRequestSchema().safeParse(written[0]).success).toBe(
      true,
    )

    const result = await decision
    expect(result.behavior).toBe('allow')

    input.close()
    await drained
  })

  test('injectControlResponse for an unknown request_id writes nothing', () => {
    const io = writeOnlyIO()
    const capture = captureStdout()
    try {
      io.injectControlResponse({
        type: 'control_response',
        response: { subtype: 'success', request_id: 'never-sent' },
      } as never)
    } finally {
      capture.restore()
    }
    expect(capture.lines()).toEqual([])
  })
})
