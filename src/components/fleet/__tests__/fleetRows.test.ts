/**
 * `fleetRows.ts` has zero imports, so these tests have zero mocks — the module
 * under test is reachable with nothing stubbed. That is the whole reason the
 * join was factored out of the hook.
 */
import { describe, expect, test } from 'bun:test'
import {
  describeFleetRowState,
  type FleetLiveSession,
  type FleetTranscript,
  fleetRowAgeMs,
  fleetRowTarget,
  formatAge,
  groupRowsByProject,
  isAttachableRow,
  isResumableRow,
  joinFleetRows,
  shortenProjectPath,
  sortFleetRows,
  UNTITLED_SESSION_LABEL,
} from '../fleetRows.js'

function live(overrides: Partial<FleetLiveSession> = {}): FleetLiveSession {
  return { pid: 100, sessionId: 'sess-live', cwd: '/repo/a', ...overrides }
}

function transcript(overrides: Partial<FleetTranscript> = {}): FleetTranscript {
  return {
    sessionId: 'sess-live',
    summary: 'fix the parser',
    cwd: '/repo/a',
    lastModified: 1_000,
    ...overrides,
  }
}

describe('joinFleetRows — the three states', () => {
  test('a PID file matched by a transcript is live', () => {
    const rows = joinFleetRows([live()], [transcript()])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('live')
    expect(rows[0]!.pid).toBe(100)
    expect(rows[0]!.sessionId).toBe('sess-live')
    expect(rows[0]!.label).toBe('fix the parser')
  })

  test('a PID file with no transcript yet is starting', () => {
    // The registry entry is written before the first transcript line, so this
    // is the normal state of a session that was spawned a moment ago.
    const rows = joinFleetRows([live({ sessionId: 'brand-new' })], [])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('starting')
    expect(rows[0]!.label).toBe(UNTITLED_SESSION_LABEL)
  })

  test('a transcript with no live process is ended and resumable', () => {
    const rows = joinFleetRows([], [transcript({ sessionId: 'old' })])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('ended')
    expect(isResumableRow(rows[0]!)).toBe(true)
  })

  test('the same session never yields two rows', () => {
    const rows = joinFleetRows(
      [live()],
      [transcript(), transcript({ sessionId: 'other', cwd: '/repo/b' })],
    )
    expect(rows.map(row => row.id).sort()).toEqual(['other', 'sess-live'])
    expect(rows.filter(row => row.sessionId === 'sess-live')).toHaveLength(1)
  })

  test('a live session with no sessionId still gets a starting row', () => {
    // Dropping it would make a just-registered session invisible; the PID slot
    // is the only stable key available at that moment.
    const rows = joinFleetRows([{ pid: 4242 }], [])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('pid:4242')
    expect(rows[0]!.state).toBe('starting')
    expect(isResumableRow(rows[0]!)).toBe(false)
  })

  test('duplicate transcript ids collapse to the most recently touched copy', () => {
    // Worktrees can index the same session under two project directories.
    const rows = joinFleetRows(
      [],
      [
        transcript({ sessionId: 'dup', summary: 'stale', lastModified: 10 }),
        transcript({ sessionId: 'dup', summary: 'fresh', lastModified: 20 }),
      ],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.label).toBe('fresh')
  })
})

describe('joinFleetRows — label and field precedence', () => {
  test('the name set on the live session outranks the transcript title', () => {
    const rows = joinFleetRows(
      [live({ name: 'deploy watch' })],
      [transcript({ customTitle: 'transcript title' })],
    )
    expect(rows[0]!.label).toBe('deploy watch')
  })

  test('customTitle outranks summary, which outranks firstPrompt', () => {
    const withTitle = joinFleetRows(
      [],
      [transcript({ customTitle: 'chosen', firstPrompt: 'ignored' })],
    )
    expect(withTitle[0]!.label).toBe('chosen')

    const withSummary = joinFleetRows(
      [],
      [
        transcript({
          customTitle: '   ',
          summary: 'from summary',
          firstPrompt: 'ignored',
        }),
      ],
    )
    expect(withSummary[0]!.label).toBe('from summary')

    const withPrompt = joinFleetRows(
      [],
      [transcript({ summary: '', firstPrompt: 'from prompt' })],
    )
    expect(withPrompt[0]!.label).toBe('from prompt')
  })

  test('a multi-line prompt collapses to one line', () => {
    // Transcript summaries and prompts routinely contain newlines. A raw
    // newline makes Ink lay the row out over two lines, which desynchronises
    // the drawn list from the selection index.
    const rows = joinFleetRows(
      [],
      [transcript({ summary: 'fix the\n\n  parser\ttoday  ' })],
    )
    expect(rows[0]!.label).toBe('fix the parser today')
  })

  test('a whitespace-only title falls through to the next candidate', () => {
    const rows = joinFleetRows(
      [live({ name: '\n  \t' })],
      [transcript({ summary: 'real title' })],
    )
    expect(rows[0]!.label).toBe('real title')
  })

  test('a live row takes cwd from the registry and branch from the transcript', () => {
    const rows = joinFleetRows(
      [live({ cwd: '/repo/live' })],
      [transcript({ cwd: '/repo/stale', gitBranch: 'feature/x' })],
    )
    expect(rows[0]!.cwd).toBe('/repo/live')
    expect(rows[0]!.gitBranch).toBe('feature/x')
  })

  test('a live row with no cwd falls back to the transcript cwd', () => {
    const rows = joinFleetRows(
      [{ pid: 7, sessionId: 'sess-live' }],
      [transcript({ cwd: '/repo/from-transcript' })],
    )
    expect(rows[0]!.cwd).toBe('/repo/from-transcript')
  })
})

describe('sortFleetRows', () => {
  test('running rows precede resumable ones regardless of recency', () => {
    const rows = joinFleetRows(
      [live({ sessionId: 'running', startedAt: 1 })],
      [
        transcript({ sessionId: 'running', lastModified: 1 }),
        transcript({ sessionId: 'recent-but-dead', lastModified: 9_999 }),
      ],
    )
    expect(rows.map(row => row.id)).toEqual(['running', 'recent-but-dead'])
  })

  test('live outranks starting, and ties break on recency then id', () => {
    const rows = sortFleetRows([
      { id: 'c', state: 'ended', label: 'c', lastActivityAt: 5 },
      { id: 'b', state: 'starting', label: 'b', startedAt: 5 },
      { id: 'a2', state: 'live', label: 'a2', startedAt: 7 },
      { id: 'a1', state: 'live', label: 'a1', startedAt: 7 },
      { id: 'a3', state: 'live', label: 'a3', startedAt: 9 },
    ])
    expect(rows.map(row => row.id)).toEqual(['a3', 'a1', 'a2', 'b', 'c'])
  })
})

describe('groupRowsByProject', () => {
  test('groups by cwd and pins the current project first', () => {
    const rows = joinFleetRows(
      [],
      [
        transcript({
          sessionId: 'old-here',
          cwd: '/repo/here',
          lastModified: 1,
        }),
        transcript({
          sessionId: 'new-there',
          cwd: '/repo/there',
          lastModified: 99,
        }),
      ],
    )
    const groups = groupRowsByProject(rows, { currentCwd: '/repo/here' })
    expect(groups.map(group => group.cwd)).toEqual([
      '/repo/here',
      '/repo/there',
    ])
    expect(groups[0]!.rows.map(row => row.id)).toEqual(['old-here'])
  })

  test('without a current project, the most recent group leads', () => {
    const rows = joinFleetRows(
      [],
      [
        transcript({ sessionId: 'a', cwd: '/repo/a', lastModified: 1 }),
        transcript({ sessionId: 'b', cwd: '/repo/b', lastModified: 99 }),
      ],
    )
    expect(groupRowsByProject(rows).map(group => group.cwd)).toEqual([
      '/repo/b',
      '/repo/a',
    ])
  })

  test('rows with no cwd land in a labelled bucket instead of vanishing', () => {
    const groups = groupRowsByProject([
      { id: 'x', state: 'starting', label: 'x' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.cwd).toBe('')
    expect(groups[0]!.label).toBe('unknown project')
  })

  test('the heading shortens the home prefix', () => {
    const groups = groupRowsByProject(
      [{ id: 'x', state: 'live', label: 'x', cwd: '/Users/me/code/app' }],
      { home: '/Users/me' },
    )
    expect(groups[0]!.label).toBe('~/code/app')
  })
})

describe('shortenProjectPath', () => {
  test('leaves unrelated paths alone', () => {
    expect(shortenProjectPath('/srv/app', '/Users/me')).toBe('/srv/app')
    expect(shortenProjectPath('/Users/me2/app', '/Users/me')).toBe(
      '/Users/me2/app',
    )
  })

  test('collapses the home directory itself', () => {
    expect(shortenProjectPath('/Users/me', '/Users/me')).toBe('~')
  })

  test('is a no-op without a home directory', () => {
    expect(shortenProjectPath('/Users/me/app')).toBe('/Users/me/app')
  })
})

describe('age', () => {
  test('formatAge reports only the highest significant unit', () => {
    expect(formatAge(0)).toBe('0s')
    expect(formatAge(45_000)).toBe('45s')
    expect(formatAge(59_999)).toBe('59s')
    expect(formatAge(60_000)).toBe('1m')
    expect(formatAge(3 * 60_000 + 59_000)).toBe('3m')
    expect(formatAge(2 * 3_600_000)).toBe('2h')
    expect(formatAge(9 * 86_400_000)).toBe('9d')
  })

  test('negative clock skew reads as zero rather than a negative age', () => {
    expect(formatAge(-5_000)).toBe('0s')
  })

  test('running rows age from process start, ended rows from last write', () => {
    const now = 100_000
    const running = joinFleetRows(
      [live({ startedAt: 40_000 })],
      [transcript({ lastModified: 90_000 })],
    )[0]!
    expect(fleetRowAgeMs(running, now)).toBe(60_000)

    const ended = joinFleetRows(
      [],
      [transcript({ sessionId: 'dead', createdAt: 1, lastModified: 90_000 })],
    )[0]!
    expect(fleetRowAgeMs(ended, now)).toBe(10_000)
  })

  test('a row with no timestamps has no age at all', () => {
    expect(fleetRowAgeMs({ id: 'x', state: 'starting', label: 'x' }, 1)).toBe(
      undefined,
    )
  })
})

describe('isAttachableRow', () => {
  test('only background sessions can be attached', () => {
    // A bg session was started through BgEngine, so it owns a tmux pane or a
    // managed log that `src/cli/bg.ts` can reconnect to.
    expect(
      isAttachableRow({ id: 'x', state: 'live', label: 'x', kind: 'bg' }),
    ).toBe(true)
    expect(
      isAttachableRow({ id: 'x', state: 'starting', label: 'x', kind: 'bg' }),
    ).toBe(true)
  })

  test('an interactive session in another terminal is not attachable', () => {
    // It has no pane and no managed log; attaching could only report that.
    expect(
      isAttachableRow({
        id: 'x',
        state: 'live',
        label: 'x',
        kind: 'interactive',
      }),
    ).toBe(false)
    expect(isAttachableRow({ id: 'x', state: 'live', label: 'x' })).toBe(false)
  })

  test('a finished session is resumable, never attachable', () => {
    const ended = {
      id: 'x',
      state: 'ended' as const,
      label: 'x',
      kind: 'bg',
      sessionId: 'x',
    }
    expect(isAttachableRow(ended)).toBe(false)
    expect(isResumableRow(ended)).toBe(true)
  })
})

describe('fleetRowTarget', () => {
  test('prefers the session id — PIDs get reused', () => {
    expect(
      fleetRowTarget({
        id: 'x',
        state: 'live',
        label: 'x',
        sessionId: 'sess-1',
        pid: 42,
      }),
    ).toBe('sess-1')
  })

  test('falls back to the PID only when there is no id yet', () => {
    expect(
      fleetRowTarget({ id: 'pid:42', state: 'starting', label: 'x', pid: 42 }),
    ).toBe('42')
  })

  test('has nothing to address when neither exists', () => {
    expect(fleetRowTarget({ id: 'x', state: 'ended', label: 'x' })).toBe(
      undefined,
    )
  })
})

describe('describeFleetRowState', () => {
  test('waitingFor outranks status, which outranks the default verb', () => {
    expect(
      describeFleetRowState({
        id: 'x',
        state: 'live',
        label: 'x',
        status: 'busy',
        waitingFor: 'permission',
      }),
    ).toBe('waiting · permission')
    expect(
      describeFleetRowState({
        id: 'x',
        state: 'live',
        label: 'x',
        status: 'busy',
      }),
    ).toBe('busy')
    expect(describeFleetRowState({ id: 'x', state: 'live', label: 'x' })).toBe(
      'running',
    )
  })

  test('terminal and pre-transcript states report themselves', () => {
    expect(describeFleetRowState({ id: 'x', state: 'ended', label: 'x' })).toBe(
      'ended',
    )
    expect(
      describeFleetRowState({ id: 'x', state: 'starting', label: 'x' }),
    ).toBe('starting')
  })
})
