/**
 * `occ remote-control` — hand remote control to Happy over ACP.
 *
 * occ no longer ships its own remote-control transport. It ships an ACP agent
 * (`occ --acp`), and Happy (https://github.com/slopus/happy, MIT) supplies the
 * client half: mobile and web apps, end-to-end encryption, and a relay you can
 * self-host by pointing HAPPY_SERVER_URL at your own deployment.
 *
 * So this command is a launcher, not a protocol: it locates `happy` on PATH and
 * execs `happy acp -- <occ> --acp`, forwarding any extra arguments to Happy.
 */
import { spawn } from 'node:child_process'
import { BIN_NAME } from '../constants/brand.js'
import { buildCliLaunch } from '../utils/process/cliLaunch.js'
import { whichSync } from '../utils/process/which.js'

/** The executable Happy installs onto PATH. */
export const HAPPY_BIN = 'happy'

/** npm package that provides the `happy` executable. */
export const HAPPY_NPM_PACKAGE = 'happy-coder'

/** Upstream repository — install instructions and self-hosting docs. */
export const HAPPY_REPO_URL = 'https://github.com/slopus/happy'

/**
 * Build the argv for `happy acp -- <occ> --acp`.
 *
 * The occ half is derived from {@link buildCliLaunch}, the same helper the
 * daemon, background sessions and tmux relaunch use. That keeps one bootstrap
 * contract: in bundled mode `execPath` *is* the occ binary, in script mode the
 * spec inserts the runtime flags and `process.argv[1]` ahead of the CLI args.
 * Hardcoding `process.execPath + process.argv[1]` here would drift from it.
 *
 * @param happyArgs Extra arguments forwarded to `happy acp` (before the `--`).
 */
export function buildHappyAcpArgv(happyArgs: readonly string[] = []): {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
} {
  const spec = buildCliLaunch(['--acp'])
  return {
    command: HAPPY_BIN,
    args: ['acp', ...happyArgs, '--', spec.execPath, ...spec.args],
    env: spec.env,
  }
}

/** Guidance printed when `happy` is not installed. */
export function happyMissingMessage(): string {
  return [
    `Remote control for ${BIN_NAME} is provided by Happy, which is not installed.`,
    '',
    'Install it with one of:',
    `  npm install -g ${HAPPY_NPM_PACKAGE}`,
    `  see ${HAPPY_REPO_URL} for other install methods`,
    '',
    `Then run \`${BIN_NAME} remote-control\` again. It starts ${BIN_NAME} as an ACP`,
    'agent and connects it to the Happy mobile and web clients.',
    '',
    'Self-hosting: point HAPPY_SERVER_URL at your own Happy server before',
    `running \`${BIN_NAME} remote-control\` and no traffic touches the hosted relay.`,
    '',
    `Editors that speak ACP (Zed, JetBrains) can attach directly with \`${BIN_NAME} --acp\`;`,
    'they do not need Happy at all.',
  ].join('\n')
}

/**
 * Locate `happy` and run it. Returns the process exit code.
 *
 * @param happyArgs Extra arguments forwarded to `happy acp`.
 * @param cwd       Working directory for the Happy process (defaults to the
 *                  current one, so the agent sees the user's project).
 */
export async function runRemoteControlLauncher(
  happyArgs: readonly string[] = [],
  cwd: string = process.cwd(),
): Promise<number> {
  if (!whichSync(HAPPY_BIN)) {
    process.stderr.write(`${happyMissingMessage()}\n`)
    return 1
  }

  const { command, args, env } = buildHappyAcpArgv(happyArgs)
  const child = spawn(command, args, {
    stdio: 'inherit',
    cwd,
    env,
    windowsHide: process.platform === 'win32',
  })

  return await new Promise<number>(resolve => {
    child.on('error', (err: Error) => {
      process.stderr.write(`Failed to start ${HAPPY_BIN}: ${err.message}\n`)
      resolve(1)
    })
    // Signal termination reports code === null; mirror the shell's 128+n.
    child.on('exit', (code, signal) => {
      if (code !== null) {
        resolve(code)
        return
      }
      resolve(signal ? 1 : 0)
    })
  })
}
