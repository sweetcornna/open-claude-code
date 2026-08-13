/**
 * `/background` — hand the whole session over to a new process and free the
 * terminal.
 *
 * WHAT THIS IS NOT
 *
 * Not Ctrl+B. `useSessionBackgrounding` moves the *current turn* into a local
 * task and keeps this process (and this terminal) exactly where it is.
 * `/background` moves the *whole conversation* into a new process and gives
 * the terminal back.
 *
 * WHAT THE HANDOVER ACTUALLY IS
 *
 * Serialize, then resume — the same thing official Claude Code does (it spawns
 * `--resume <transcript> --fork-session`, it does not migrate a live process).
 * The consequences are load-bearing and the UI has to say them out loud:
 *
 *   - only what is on disk carries over, which is why the caller must flush
 *     first and abandon the whole operation if the flush fails;
 *   - the new process forks the conversation. `--fork-session` plus an
 *     explicit `--session-id` means the child writes to a *different*
 *     transcript, so the parent's own shutdown writes cannot interleave with
 *     the child's, and we know the child's session id before it boots (which
 *     is what makes the printed `attach`/`logs`/`stop` hints correct).
 *
 * Everything here except {@link runHandoff} is pure, so the argument shape,
 * the env scrubbing and the hint text are all unit-testable without spawning.
 */

import { BIN_NAME, occConfigPath } from '../../config/paths.js'
import type { BgEngine } from './engine.js'
import { newJobId, writeJob } from './jobStore.js'

/**
 * Env keys that name *this* session or job. A child that inherits them would
 * believe it is the process we are about to shut down — official strips the
 * same class (`BG_WORKER_IDENTITY_ENV_VARS`, `CLAUDE_JOB_DIR`, `CLAUDE_BG_*`)
 * before respawning. Credentials are deliberately not in this list: they are
 * not identity, and dropping them would leave the child unauthenticated.
 */
export const HANDOFF_STRIPPED_ENV_KEYS = [
  'CLAUDE_CODE_SESSION_KIND',
  'CLAUDE_CODE_SESSION_NAME',
  'CLAUDE_CODE_SESSION_LOG',
  'CLAUDE_CODE_SESSION_ENGINE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_TMUX_SESSION',
  'CLAUDE_JOB_DIR',
  'OCC_JOB_ID',
] as const

/** Prefixes stripped wholesale, mirroring official's `CLAUDE_BG_*` sweep. */
const HANDOFF_STRIPPED_ENV_PREFIXES = ['CLAUDE_BG_'] as const

export function sanitizeHandoffEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if ((HANDOFF_STRIPPED_ENV_KEYS as readonly string[]).includes(key)) continue
    if (HANDOFF_STRIPPED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
      continue
    }
    result[key] = value
  }
  return result
}

type HandoffPlanInput = {
  /** Conversation the background process resumes from. */
  sessionId: string
  /** Optional prompt to run once resumed (`/background <prompt>`). */
  prompt?: string
  /** Directory the child must start in — `--resume` resolves against cwd. */
  cwd: string
  /** False for engines with no TTY (no tmux): the child must run in print mode. */
  interactive: boolean
  /** Session id the forked conversation will use. Generated when omitted. */
  forkSessionId: string
  autoCompactWindow?: number
  autoCompactWindowOverride?: boolean
  jobId?: string
}

type HandoffPlan = {
  jobId: string
  sessionName: string
  logPath: string
  /** Conversation the child forks from. */
  sourceSessionId: string
  /** Conversation the child will write to. */
  forkSessionId: string
  cwd: string
  interactive: boolean
  args: string[]
}

/**
 * Build the child's argv. `--fork-session` needs an explicit `--session-id` to
 * be predictable, and rootAction only accepts `--session-id` alongside
 * `--resume` when `--fork-session` is present — the three travel together.
 *
 * The prompt goes after `--` so a prompt that starts with a dash is an
 * operand and not a flag.
 */
export function planHandoff(input: HandoffPlanInput): HandoffPlan {
  const jobId = input.jobId ?? newJobId()
  const sessionName = `${BIN_NAME}-bg-${jobId}`
  const args = [
    '--resume',
    input.sessionId,
    '--fork-session',
    '--session-id',
    input.forkSessionId,
  ]
  if (input.autoCompactWindowOverride) {
    args.push(
      '--autocompact',
      input.autoCompactWindow === undefined
        ? 'auto'
        : String(input.autoCompactWindow),
    )
  }
  // Without a TTY the child cannot host a REPL, so a prompt-less handover is
  // refused upstream and a prompted one runs headless into the log.
  if (!input.interactive) args.push('-p')
  if (input.prompt) args.push('--', input.prompt)

  return {
    jobId,
    sessionName,
    logPath: occConfigPath('sessions', 'logs', `${sessionName}.log`),
    sourceSessionId: input.sessionId,
    forkSessionId: input.forkSessionId,
    cwd: input.cwd,
    interactive: input.interactive,
    args,
  }
}

/**
 * The four commands the user needs after the terminal comes back, in the same
 * order official prints them.
 */
export function formatHandoffHints(plan: HandoffPlan, title?: string): string {
  const header = title
    ? `backgrounded · ${plan.sessionName} · ${title}`
    : `backgrounded · ${plan.sessionName}`
  const rows: Array<[string, string]> = [
    [`${BIN_NAME} agents`, 'list sessions'],
    [`${BIN_NAME} daemon attach ${plan.sessionName}`, 'open in this terminal'],
    [`${BIN_NAME} daemon logs ${plan.sessionName}`, 'show recent output'],
    [`${BIN_NAME} stop ${plan.sessionName}`, 'stop this session'],
  ]
  const width = Math.max(...rows.map(([command]) => command.length))
  return [
    header,
    ...rows.map(([command, note]) => `  ${command.padEnd(width)}  ${note}`),
  ].join('\n')
}

type HandoffResult = {
  plan: HandoffPlan
  engineUsed: 'tmux' | 'detached'
  pid: number
}

/**
 * Start the background process and record the job. The job record is written
 * before returning so `stop`/`rm`/`agents` can see the session even if the
 * child dies during boot.
 */
export async function runHandoff(
  plan: HandoffPlan,
  engine: BgEngine,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HandoffResult> {
  const result = await engine.start({
    sessionName: plan.sessionName,
    args: plan.args,
    env: sanitizeHandoffEnv(env),
    logPath: plan.logPath,
    cwd: plan.cwd,
  })

  await writeJob({
    jobId: plan.jobId,
    state: 'running',
    detail: 'backgrounded from an interactive session',
    tempo: 'active',
    name: plan.sessionName,
    sessionId: plan.forkSessionId,
    pid: result.pid || undefined,
    cwd: plan.cwd,
    logPath: result.logPath,
    engine: result.engineUsed,
  })

  return { plan, engineUsed: result.engineUsed, pid: result.pid }
}
