import { describe, expect, test } from 'bun:test'
import { parseRemoteControlArgs } from '../parseArgs.js'

describe('/remote-control argument parsing', () => {
  test('routes the reserved subcommands', () => {
    expect(parseRemoteControlArgs('logout')).toEqual({ kind: 'logout' })
    expect(parseRemoteControlArgs('status')).toEqual({ kind: 'status' })
    expect(parseRemoteControlArgs('login')).toEqual({
      kind: 'auth',
      action: 'login',
    })
    expect(parseRemoteControlArgs('register')).toEqual({
      kind: 'auth',
      action: 'register',
    })
  })

  test('tolerates the whitespace a slash command arrives with', () => {
    expect(parseRemoteControlArgs('  status  ')).toEqual({ kind: 'status' })
    expect(parseRemoteControlArgs('\tlogin\n')).toEqual({
      kind: 'auth',
      action: 'login',
    })
  })

  test('treats a bare invocation as connect-without-a-name', () => {
    for (const args of ['', '   ', '\n']) {
      expect(parseRemoteControlArgs(args)).toEqual({
        kind: 'connect',
        name: undefined,
      })
    }
  })

  test('treats anything else as the session name', () => {
    expect(parseRemoteControlArgs('my-laptop')).toEqual({
      kind: 'connect',
      name: 'my-laptop',
    })
    // Reserved words are matched exactly, so these stay names.
    expect(parseRemoteControlArgs('login-box')).toEqual({
      kind: 'connect',
      name: 'login-box',
    })
    expect(parseRemoteControlArgs('Status')).toEqual({
      kind: 'connect',
      name: 'Status',
    })
    expect(parseRemoteControlArgs('status extra')).toEqual({
      kind: 'connect',
      name: 'status extra',
    })
  })
})
