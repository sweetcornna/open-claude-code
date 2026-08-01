import { describe, expect, test } from 'bun:test'

import {
  buildHappyAcpArgv,
  HAPPY_BIN,
  HAPPY_NPM_PACKAGE,
  HAPPY_REPO_URL,
  happyMissingMessage,
} from '../remoteControlLauncher.js'

describe('buildHappyAcpArgv', () => {
  test('execs happy acp with the occ ACP agent after the separator', () => {
    const { command, args } = buildHappyAcpArgv()
    expect(command).toBe(HAPPY_BIN)
    expect(args[0]).toBe('acp')
    const sep = args.indexOf('--')
    expect(sep).toBeGreaterThan(0)
    // Everything after `--` is the agent command line, ending in --acp.
    expect(args.slice(sep + 1).length).toBeGreaterThan(0)
    expect(args.at(-1)).toBe('--acp')
  })

  test('forwards extra arguments to happy, not to the agent', () => {
    const { args } = buildHappyAcpArgv(['--yolo'])
    const sep = args.indexOf('--')
    expect(args.slice(0, sep)).toEqual(['acp', '--yolo'])
    expect(args.slice(sep + 1)).not.toContain('--yolo')
  })

  test('passes an environment through for the child process', () => {
    const { env } = buildHappyAcpArgv()
    expect(typeof env).toBe('object')
  })
})

describe('happyMissingMessage', () => {
  test('names the npm package, the repo and the self-host env var', () => {
    const msg = happyMissingMessage()
    expect(msg).toContain(`npm install -g ${HAPPY_NPM_PACKAGE}`)
    expect(msg).toContain(HAPPY_REPO_URL)
    expect(msg).toContain('HAPPY_SERVER_URL')
  })

  test('mentions the direct ACP route for editors', () => {
    expect(happyMissingMessage()).toContain('--acp')
  })
})
