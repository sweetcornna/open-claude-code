import { existsSync } from 'fs'
import { resolve } from 'path'
import { BIN_NAME } from 'src/config/paths.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { captureProcess } from '../utils/process/spawnPortable.js'

const SSH_TIMEOUT_MS = 60_000
export const REMOTE_BIN_DIR = '~/.local/bin'
export const REMOTE_CLI_FILE = 'open-claude-code-cli.js'
export const REMOTE_WRAPPER = BIN_NAME

export interface DeployOptions {
  host: string
  remotePlatform: string
  remoteArch: string
  localVersion: string
  onProgress?: (msg: string) => void
}

async function runSshCommand(
  host: string,
  command: string,
  timeoutMs = SSH_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, exitCode, timedOut } = await captureProcess(
    ['ssh', '-o', 'ConnectTimeout=10', host, command],
    { timeoutMs },
  )
  return {
    stdout: stdout.trim(),
    stderr: timedOut
      ? `${stderr.trim()}\nssh timed out after ${timeoutMs / 1000}s`.trim()
      : stderr.trim(),
    // A killed or failed-to-spawn child has no exit code; report it as a
    // failure rather than letting `exitCode !== 0` checks see null.
    exitCode: exitCode ?? 1,
  }
}

function findLocalBinary(): string {
  const projectRoot = resolve(import.meta.dir, '../..')
  const distPath = resolve(projectRoot, 'dist/cli.js')
  if (existsSync(distPath)) return distPath

  const devPath = resolve(projectRoot, 'src/entrypoints/cli.tsx')
  if (existsSync(devPath)) return devPath

  throw new Error(
    'Cannot find local CLI binary to deploy. Run `bun run build` first.',
  )
}

export async function deployBinary(options: DeployOptions): Promise<string> {
  const { host, remotePlatform, remoteArch, localVersion, onProgress } = options

  if (remotePlatform !== 'linux' && remotePlatform !== 'darwin') {
    throw new Error(
      `Remote platform "${remotePlatform}" is not supported. Only linux and darwin are supported.`,
    )
  }

  logForDebugging(
    `[SSHDeploy] deploying to ${host} (${remotePlatform}/${remoteArch}, v${localVersion})`,
  )

  const localBinary = findLocalBinary()
  logForDebugging(`[SSHDeploy] local binary: ${localBinary}`)

  onProgress?.('Creating remote directory...')
  const mkdirResult = await runSshCommand(host, `mkdir -p ${REMOTE_BIN_DIR}`)
  if (mkdirResult.exitCode !== 0) {
    throw new Error(`Failed to create remote directory: ${mkdirResult.stderr}`)
  }

  onProgress?.('Uploading binary...')
  const remotePath = `${REMOTE_BIN_DIR}/${REMOTE_CLI_FILE}`
  const { stderr: scpStderr, exitCode: scpExit } = await captureProcess(
    ['scp', '-o', 'ConnectTimeout=10', localBinary, `${host}:${remotePath}`],
    { timeoutMs: SSH_TIMEOUT_MS },
  )

  if (scpExit !== 0) {
    throw new Error(`SCP upload failed (exit ${scpExit}): ${scpStderr.trim()}`)
  }

  onProgress?.('Installing wrapper script...')
  const wrapperScript = [
    `cat > ${REMOTE_BIN_DIR}/${REMOTE_WRAPPER} << 'WRAPPER'`,
    '#!/bin/sh',
    `exec bun ${REMOTE_BIN_DIR}/${REMOTE_CLI_FILE} "$@"`,
    'WRAPPER',
    `chmod +x ${REMOTE_BIN_DIR}/${REMOTE_WRAPPER}`,
  ].join('\n')

  const wrapperResult = await runSshCommand(host, wrapperScript)
  if (wrapperResult.exitCode !== 0) {
    throw new Error(`Failed to install wrapper script: ${wrapperResult.stderr}`)
  }

  onProgress?.('Verifying installation...')
  const verifyResult = await runSshCommand(
    host,
    `${REMOTE_BIN_DIR}/${REMOTE_WRAPPER} --version`,
  )
  if (verifyResult.exitCode !== 0) {
    throw new Error(
      `Binary deployed but verification failed (exit ${verifyResult.exitCode}): ${verifyResult.stderr}`,
    )
  }

  logForDebugging(
    `[SSHDeploy] deployed successfully, remote version: ${verifyResult.stdout}`,
  )
  onProgress?.(`Deployed v${verifyResult.stdout}`)

  return `${REMOTE_BIN_DIR}/${REMOTE_WRAPPER}`
}
