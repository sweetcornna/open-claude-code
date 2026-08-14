/**
 * How one eval run actually reaches a model.
 *
 * WHY A SUBPROCESS AND NOT AN IN-PROCESS SANDBOX
 *
 * The ablation needs two sessions that differ in exactly one bit: whether the
 * plugin under test is loaded. Plugin loading in occ is not reversible inside a
 * process — the loader memoizes, hooks register globally, MCP servers get
 * spawned, and skill listings are cached. Attempting "load, run, unload, run
 * again" would be measuring leftovers. A fresh `occ -p` child per run makes the
 * isolation structural rather than something to maintain: the control arm is
 * byte-identical to the treatment arm minus one `--plugin-dir` argument.
 *
 * It also means the eval inherits whatever provider, auth and model the user
 * already has working, with no second credential path to keep in sync.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { buildCliLaunch, spawnCli } from '../../process/cliLaunch.js'
import type { AgentRunOutcome, ToolCall } from './types.js'

export type AgentRunRequest = {
  prompt: string
  /** Workspace directory; becomes the child's cwd. */
  cwd: string
  /** Plugin roots to load. Empty for the control arm — this is the ablation. */
  pluginDirs: string[]
  model?: string
  allowedTools: string[]
  maxTurns: number
  /** Hard per-run wall clock. The child is SIGKILLed past this. */
  timeoutMs: number
  /** Passed through as `--max-budget-usd` so one run cannot eat the ceiling. */
  maxBudgetUsd?: number
  /** Where to write `trace.jsonl`. Skipped when undefined. */
  traceDir?: string
  /** Emits `--tools ""`, stripping the built-in set. Used by the judge. */
  disableTools?: boolean
  /**
   * Replaces occ's default system prompt via `--system-prompt`.
   *
   * The judge needs this. Left on the coding-agent prompt it answers like a
   * coding agent — "I'll inspect NOTES.md first…" — and never emits a verdict,
   * which fails closed and scores every judged case zero.
   */
  systemPrompt?: string
  signal?: AbortSignal
}

/**
 * The seam that lets every gate, aggregation and reporting path be tested
 * without a model. Injected through the whole runner rather than mocked: a
 * process-global `mock.module` would leak into sibling test files.
 */
export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunOutcome>
}

/** Cap on retained child stdout, mirroring the upstream 64 MiB guard. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024

/**
 * Environment every arm shares.
 *
 * These are noise suppressors, applied identically to both arms so they cancel
 * out of the delta. `CLAUDE_CODE_DISABLE_CLAUDE_MDS` matters most: the
 * workspace is a throwaway directory, but occ walks upward looking for
 * `CLAUDE.md`, so without this the operator's home-directory memory would leak
 * into every run and vary by machine.
 *
 * DO NOT SET `CI=1` HERE. It looks like the obvious "this is not a terminal"
 * hint, but `getAnthropicApiKeyWithSource` treats it as a signal to stop
 * consulting the keychain and OAuth and demand an explicit API key
 * (`utils/auth/auth.ts`). Every run then exits 0 having produced nothing —
 * no error, no transcript, just an empty result and a zero score. Non-TTY
 * rendering is already handled by `--output-format stream-json`.
 */
export function evalChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  }
}

/**
 * Assemble the child argv.
 *
 * The prompt goes immediately after `-p` and before every flag: several occ
 * options are variadic (`<tools...>`), and a variadic option directly ahead of
 * a bare positional would swallow it.
 *
 * `--permission-mode dontAsk` is the pairing that makes unattended runs safe —
 * it never prompts and denies anything not pre-approved, so `--allowed-tools`
 * becomes the complete list of what a case can do.
 */
export function buildAgentArgs(request: AgentRunRequest): string[] {
  const args = ['-p', request.prompt]
  args.push('--output-format', 'stream-json', '--verbose')
  args.push('--permission-mode', 'dontAsk')
  args.push('--max-turns', String(request.maxTurns))
  args.push('--strict-mcp-config')
  if (request.model !== undefined) args.push('--model', request.model)
  if (request.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(request.maxBudgetUsd))
  }
  if (request.systemPrompt !== undefined) {
    args.push('--system-prompt', request.systemPrompt)
  }
  if (request.disableTools === true) {
    // Documented spelling for "no built-in tools at all".
    args.push('--tools', '')
  } else if (request.allowedTools.length > 0) {
    // One comma-joined token: the option is variadic, and a bare list would
    // keep consuming until the next `-`-prefixed argument.
    args.push('--allowed-tools', request.allowedTools.join(','))
  }
  // Repeatable single-value option — never a space-separated list (gh-33508).
  for (const dir of request.pluginDirs) args.push('--plugin-dir', dir)
  return args
}

type StreamResult = {
  subtype?: string
  is_error?: boolean
  result?: string
  total_cost_usd?: number
  num_turns?: number
  duration_ms?: number
  session_id?: string
  errors?: string[]
}

/**
 * Fold one stream-json line into the accumulating outcome.
 *
 * Exported for tests: the transcript shape is the contract between occ's print
 * mode and every `tool_used` / `skill_used` assertion, and it is worth pinning
 * without spawning anything.
 */
export function consumeStreamLine(
  line: string,
  acc: { toolCalls: ToolCall[]; result?: StreamResult },
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null) return
  const message = parsed as Record<string, unknown>

  if (message.type === 'result') {
    acc.result = message as StreamResult
    return
  }
  if (message.type !== 'assistant') return

  const inner = message.message as { content?: unknown } | undefined
  const content = inner?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type !== 'tool_use' || typeof b.name !== 'string') continue
    let inputJson = '{}'
    try {
      inputJson = JSON.stringify(b.input ?? {})
    } catch {
      inputJson = '{}'
    }
    acc.toolCalls.push({ name: b.name, inputJson })
  }
}

/** Turn a completed stream into the outcome graders consume. */
export function outcomeFromStream(
  acc: { toolCalls: ToolCall[]; result?: StreamResult },
  fallback: { durationMs: number; error?: string },
): AgentRunOutcome {
  const result = acc.result
  if (fallback.error !== undefined || result === undefined) {
    return {
      ok: false,
      output: '',
      toolCalls: acc.toolCalls,
      costUsd: result?.total_cost_usd ?? 0,
      numTurns: result?.num_turns ?? 0,
      durationMs: fallback.durationMs,
      error: fallback.error ?? 'agent produced no result message',
    }
  }
  const failed = result.is_error === true || result.subtype !== 'success'
  return {
    ok: !failed,
    output: typeof result.result === 'string' ? result.result : '',
    toolCalls: acc.toolCalls,
    costUsd: result.total_cost_usd ?? 0,
    numTurns: result.num_turns ?? 0,
    durationMs: result.duration_ms ?? fallback.durationMs,
    sessionId: result.session_id,
    error: failed
      ? (result.errors?.join('; ') ?? result.subtype ?? 'agent run failed')
      : undefined,
  }
}

/** Spawns a real `occ -p` child. The production {@link AgentRunner}. */
export class SubprocessAgentRunner implements AgentRunner {
  async run(request: AgentRunRequest): Promise<AgentRunOutcome> {
    const started = Date.now()
    const args = buildAgentArgs(request)
    const spec = buildCliLaunch(args, { env: evalChildEnv(process.env) })

    const acc: { toolCalls: ToolCall[]; result?: StreamResult } = {
      toolCalls: [],
    }
    const rawLines: string[] = []
    let stderr = ''
    let error: string | undefined

    await new Promise<void>(done => {
      const child = spawnCli(spec, {
        cwd: request.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let settled = false
      let stdoutBytes = 0
      let buffer = ''

      const finish = (err?: string): void => {
        if (settled) return
        settled = true
        if (err !== undefined) error = err
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        done()
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(`timed out after ${Math.round(request.timeoutMs / 1000)}s`)
      }, request.timeoutMs)
      const onAbort = (): void => {
        child.kill('SIGKILL')
        finish('interrupted')
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          child.kill('SIGKILL')
          finish('agent produced more than 64 MiB of output')
          return
        }
        buffer += chunk.toString('utf8')
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line !== '') {
            rawLines.push(line)
            consumeStreamLine(line, acc)
          }
          newline = buffer.indexOf('\n')
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
      })
      child.on('error', spawnError =>
        finish(`spawn failed: ${String(spawnError)}`),
      )
      child.on('close', code => {
        const tail = buffer.trim()
        if (tail !== '') {
          rawLines.push(tail)
          consumeStreamLine(tail, acc)
        }
        // A non-zero exit with a well-formed result message is still a graded
        // run (e.g. `error_max_turns`); only a silent crash is a runner error.
        // A *zero* exit with no result message is the confusing case — the
        // child declined to do anything — so carry its stderr out too rather
        // than reporting a bare "no result message".
        if (acc.result === undefined) {
          const tail = stderr.slice(-2000).trim()
          finish(
            `exit ${code ?? 'null'}, no result message` +
              (tail === '' ? ' (child wrote nothing to stderr)' : `: ${tail}`),
          )
          return
        }
        finish()
      })
    })

    if (request.traceDir !== undefined) {
      try {
        mkdirSync(request.traceDir, { recursive: true })
        writeFileSync(
          join(request.traceDir, 'trace.jsonl'),
          rawLines.join('\n') + (rawLines.length > 0 ? '\n' : ''),
        )
      } catch {
        // A missing trace must never fail an otherwise good run.
      }
    }

    return outcomeFromStream(acc, {
      durationMs: Date.now() - started,
      error,
    })
  }
}
