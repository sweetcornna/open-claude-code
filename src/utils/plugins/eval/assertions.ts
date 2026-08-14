/**
 * Deterministic grading for `occ plugin eval`.
 *
 * Every assertion here is decided by the filesystem, the run transcript or an
 * exit code. None of them costs a model call, which is why they are the
 * default way to grade a case and the LLM judge is opt-in.
 */

import { spawn } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import { type Assertion, assertionLabel } from './caseSchema.js'
import type { AgentRunOutcome, GraderResult } from './types.js'

/** Result of running one shell command for a `command` assertion. */
export type CommandOutcome = { exitCode: number; stdout: string }

export type AssertionContext = {
  /** Absolute path of the run's workspace. All case paths resolve under it. */
  workspace: string
  outcome: AgentRunOutcome
  /** `--allow-assert-commands`; false makes `command` assertions fail closed. */
  allowCommands: boolean
  signal?: AbortSignal
  /** Injection point for tests; defaults to a real subprocess. */
  runCommand?: (
    command: string,
    opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  ) => Promise<CommandOutcome>
}

/** Largest file we will read to grade `file_matches`. */
const MAX_GRADED_FILE_BYTES = 4 * 1024 * 1024

/**
 * Resolve a case-declared path inside the workspace.
 *
 * Returns null for absolute paths and anything that climbs out via `..`. A
 * case file is untrusted input: without this, `path: ../../.ssh/id_rsa` would
 * turn a grader into a file-existence oracle for the host.
 */
export function resolveWorkspacePath(
  workspace: string,
  candidate: string,
): string | null {
  if (isAbsolute(candidate)) return null
  const resolved = resolve(workspace, candidate)
  const rel = relative(workspace, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return resolved
}

/** Compile a case-supplied pattern, refusing the stateful `g` flag. */
function compile(pattern: string, flags?: string): RegExp | null {
  try {
    return new RegExp(pattern, flags ?? '')
  } catch {
    return null
  }
}

function matchVerdict(
  found: boolean,
  mode: 'contains' | 'not_contains',
): boolean {
  return mode === 'contains' ? found : !found
}

async function defaultRunCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<CommandOutcome> {
  return await new Promise<CommandOutcome>(resolvePromise => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // TERM=dumb keeps tools from emitting escape sequences into stdout that
      // a `stdout_matches` pattern would then have to tolerate.
      env: { ...process.env, TERM: 'dumb' },
    })
    let stdout = ''
    let settled = false
    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ exitCode, stdout })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(124)
    }, opts.timeoutMs)
    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish(130)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      // Cap retained output; a runaway command should not blow up the report.
      if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8')
    })
    child.on('error', () => finish(127))
    child.on('close', code => finish(code ?? 1))
  })
}

/** Does this transcript entry look like an invocation of `skill`? */
function skillInvoked(inputJson: string, skill: string): boolean {
  try {
    const parsed = JSON.parse(inputJson) as Record<string, unknown>
    // The Skill tool carries the skill name under `command` (or `skill` for
    // plugin-scoped entries); both spellings appear in transcripts.
    for (const key of ['command', 'skill', 'name']) {
      const value = parsed[key]
      if (typeof value !== 'string') continue
      // `plugin:skill-name` and bare `skill-name` both count.
      const tail = value.includes(':')
        ? value.slice(value.lastIndexOf(':') + 1)
        : value
      if (value === skill || tail === skill) return true
    }
    return false
  } catch {
    return false
  }
}

async function evaluateOne(
  assertion: Assertion,
  ctx: AssertionContext,
): Promise<GraderResult> {
  const base = {
    label: assertionLabel(assertion),
    kind: 'assert' as const,
    weight: assertion.weight,
    withOnly: assertion.arm === 'with-only',
  }
  const fail = (detail: string): GraderResult => ({
    ...base,
    passed: false,
    detail,
  })
  const pass = (detail: string): GraderResult => ({
    ...base,
    passed: true,
    detail,
  })

  switch (assertion.type) {
    case 'file_exists':
    case 'file_absent': {
      const target = resolveWorkspacePath(ctx.workspace, assertion.path)
      if (target === null) {
        return fail(`path "${assertion.path}" escapes the workspace`)
      }
      const there = existsSync(target)
      const wantThere = assertion.type === 'file_exists'
      if (there === wantThere) {
        return pass(wantThere ? 'file is present' : 'file is absent')
      }
      return fail(wantThere ? 'file was never created' : 'file is still there')
    }

    case 'file_matches': {
      const target = resolveWorkspacePath(ctx.workspace, assertion.path)
      if (target === null) {
        return fail(`path "${assertion.path}" escapes the workspace`)
      }
      if (!existsSync(target)) return fail('file does not exist')
      const size = statSync(target).size
      if (size > MAX_GRADED_FILE_BYTES) {
        return fail(
          `file is ${size} bytes, over the ${MAX_GRADED_FILE_BYTES} grading cap`,
        )
      }
      const re = compile(assertion.pattern, assertion.flags)
      if (re === null) return fail(`invalid regex /${assertion.pattern}/`)
      const found = re.test(readFileSync(target, 'utf8'))
      return matchVerdict(found, assertion.match)
        ? pass(found ? 'pattern found' : 'pattern correctly absent')
        : fail(found ? 'pattern found but should not be' : 'pattern not found')
    }

    case 'output_matches': {
      const re = compile(assertion.pattern, assertion.flags)
      if (re === null) return fail(`invalid regex /${assertion.pattern}/`)
      const found = re.test(ctx.outcome.output)
      return matchVerdict(found, assertion.match)
        ? pass(found ? 'pattern found in output' : 'pattern correctly absent')
        : fail(
            found
              ? 'pattern found but should not be'
              : 'pattern not found in output',
          )
    }

    case 'tool_used': {
      const re =
        assertion.input_matches === undefined
          ? null
          : compile(assertion.input_matches)
      if (assertion.input_matches !== undefined && re === null) {
        return fail(`invalid regex /${assertion.input_matches}/`)
      }
      const count = ctx.outcome.toolCalls.filter(
        c => c.name === assertion.tool && (re === null || re.test(c.inputJson)),
      ).length
      if (count < assertion.min) {
        return fail(`used ${count}×, expected at least ${assertion.min}`)
      }
      if (assertion.max !== undefined && count > assertion.max) {
        return fail(`used ${count}×, expected at most ${assertion.max}`)
      }
      return pass(`used ${count}×`)
    }

    case 'skill_used': {
      const count = ctx.outcome.toolCalls.filter(
        c => c.name === 'Skill' && skillInvoked(c.inputJson, assertion.skill),
      ).length
      return count >= assertion.min
        ? pass(`invoked ${count}×`)
        : fail(`invoked ${count}×, expected at least ${assertion.min}`)
    }

    case 'command': {
      if (!ctx.allowCommands) {
        return fail(
          'command assertions are disabled — re-run with --allow-assert-commands ' +
            'if you trust this case file',
        )
      }
      const run = ctx.runCommand ?? defaultRunCommand
      const { exitCode, stdout } = await run(assertion.run, {
        cwd: ctx.workspace,
        timeoutMs: assertion.timeout_ms,
        signal: ctx.signal,
      })
      if (exitCode !== assertion.expect_exit_code) {
        return fail(
          `exited ${exitCode}, expected ${assertion.expect_exit_code}`,
        )
      }
      if (assertion.stdout_matches !== undefined) {
        const re = compile(assertion.stdout_matches)
        if (re === null)
          return fail(`invalid regex /${assertion.stdout_matches}/`)
        if (!re.test(stdout))
          return fail(`exited ${exitCode} but stdout did not match`)
      }
      return pass(`exited ${exitCode}`)
    }
  }
}

/**
 * Evaluate every assertion for one run.
 *
 * `arm` decides which assertions run at all: a `with-only` assertion is
 * meaningless in the control arm, so it is skipped there rather than recorded
 * as a failure.
 */
export async function evaluateAssertions(
  assertions: readonly Assertion[],
  ctx: AssertionContext,
  arm: 'with' | 'without',
): Promise<GraderResult[]> {
  const results: GraderResult[] = []
  for (const assertion of assertions) {
    if (arm === 'without' && assertion.arm === 'with-only') continue
    results.push(await evaluateOne(assertion, ctx))
  }
  return results
}
