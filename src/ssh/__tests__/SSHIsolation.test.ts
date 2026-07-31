import { describe, expect, test } from 'bun:test'
import { BIN_NAME } from 'src/config/paths.js'
import {
  REMOTE_BIN_DIR,
  REMOTE_CLI_FILE,
  REMOTE_WRAPPER,
} from '../SSHDeploy.js'
import { buildRemoteProbeCommand } from '../SSHProbe.js'

describe('SSH remote identity', () => {
  test('probes only the occ remote binary', () => {
    const command = buildRemoteProbeCommand()

    expect(command).toContain(`$HOME/.local/bin/${BIN_NAME}`)
    expect(command).toContain(`command -v ${BIN_NAME}`)
    expect(command).not.toContain('$HOME/.local/bin/claude')
    expect(command).not.toContain('command -v claude')
  })

  test('deploys an occ wrapper without using the official binary name', () => {
    expect(REMOTE_BIN_DIR).toBe('~/.local/bin')
    expect(REMOTE_WRAPPER).toBe(BIN_NAME)
    expect(REMOTE_CLI_FILE).toBe('open-claude-code-cli.js')
    expect(REMOTE_WRAPPER).not.toBe('claude')
  })
})
