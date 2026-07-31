import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

const { commandLooksLikeOcc, isOccProcess } = await import('../pidLock.js')

const EXEC_PATH = '/home/user/.local/share/occ/versions/2.8.4/cli-bun.js'

describe('commandLooksLikeOcc', () => {
  test('matches a plain occ invocation', () => {
    expect(commandLooksLikeOcc('occ --resume', EXEC_PATH)).toBe(true)
  })

  test('matches occ launched by absolute path', () => {
    expect(commandLooksLikeOcc('/usr/local/bin/occ -p "hi"', EXEC_PATH)).toBe(
      true,
    )
  })

  test('matches the full product name', () => {
    expect(
      commandLooksLikeOcc('node /usr/lib/open-claude-code/cli.js', EXEC_PATH),
    ).toBe(true)
  })

  test('matches an indirect launch via the expected exec path', () => {
    // occ is often run as `bun <installdir>/cli-bun.js`, where the command
    // never contains the string 'occ'.
    expect(commandLooksLikeOcc(`bun ${EXEC_PATH}`, EXEC_PATH)).toBe(true)
  })

  test('is case insensitive', () => {
    expect(commandLooksLikeOcc('/opt/OCC --version', EXEC_PATH)).toBe(true)
  })

  // The regression this whole predicate exists for.
  test("does NOT match Anthropic's official claude CLI", () => {
    expect(commandLooksLikeOcc('claude --resume', EXEC_PATH)).toBe(false)
    expect(
      commandLooksLikeOcc('/usr/local/bin/claude -p "hi"', EXEC_PATH),
    ).toBe(false)
    expect(
      commandLooksLikeOcc(
        'node /home/user/.local/share/claude/versions/2.0.1/cli.js',
        EXEC_PATH,
      ),
    ).toBe(false)
  })

  test('does not match unrelated processes', () => {
    expect(commandLooksLikeOcc('vim notes.md', EXEC_PATH)).toBe(false)
    expect(commandLooksLikeOcc('', EXEC_PATH)).toBe(false)
  })

  test('does not match words that merely contain the bin name', () => {
    expect(commandLooksLikeOcc('/usr/bin/occupancy-daemon', EXEC_PATH)).toBe(
      false,
    )
    expect(commandLooksLikeOcc('moccasin --serve', EXEC_PATH)).toBe(false)
  })
})

describe('isOccProcess', () => {
  // A live PID that is not the test process, so the command-inspection branch
  // is actually reached (pid === process.pid short-circuits to true).
  function withLiveProcess(run: (pid: number) => void): void {
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore' })
    try {
      run(child.pid)
    } finally {
      child.kill()
    }
  }

  test('trusts the PID check when the command is unreadable', () => {
    // Conservative: we would rather keep a lock than delete a live version.
    withLiveProcess(pid => {
      expect(isOccProcess(pid, EXEC_PATH, () => null)).toBe(true)
    })
  })

  test('trusts the PID check when reading the command throws', () => {
    withLiveProcess(pid => {
      expect(
        isOccProcess(pid, EXEC_PATH, () => {
          throw new Error('ps unavailable')
        }),
      ).toBe(true)
    })
  })

  test('accepts a live process whose command names occ', () => {
    withLiveProcess(pid => {
      expect(isOccProcess(pid, EXEC_PATH, () => 'occ --resume')).toBe(true)
    })
  })

  test('rejects a live process running the official claude CLI', () => {
    withLiveProcess(pid => {
      expect(isOccProcess(pid, EXEC_PATH, () => 'claude --resume')).toBe(false)
    })
  })

  test('short-circuits to true for the current process', () => {
    expect(isOccProcess(process.pid, EXEC_PATH, () => 'vim')).toBe(true)
  })

  test('returns false for a PID that is not running', () => {
    // PID 0 and 1 are rejected outright by isProcessRunning.
    expect(isOccProcess(0, EXEC_PATH, () => 'occ')).toBe(false)
    expect(isOccProcess(1, EXEC_PATH, () => 'occ')).toBe(false)
  })
})
