/**
 * `occ agents --json` shaping. Pure function, so no mocks and no filesystem.
 */
import { describe, expect, test } from 'bun:test'
import type { FleetRow } from '../fleetRows.js'
import { fleetRowsToJson, isPathWithin } from '../fleetJson.js'

const live: FleetRow = {
  id: 'sess-live',
  state: 'live',
  label: 'fixing the parser',
  sessionId: 'sess-live',
  pid: 4242,
  cwd: '/repo/app',
  gitBranch: 'feature/x',
  kind: 'interactive',
  status: 'busy',
  startedAt: 1000,
  lastActivityAt: 2000,
}

const ended: FleetRow = {
  id: 'sess-ended',
  state: 'ended',
  label: 'old session',
  sessionId: 'sess-ended',
  cwd: '/repo/other',
  lastActivityAt: 500,
}

const starting: FleetRow = {
  id: 'pid:99',
  state: 'starting',
  label: 'new session',
  pid: 99,
}

describe('fleetRowsToJson', () => {
  test('emits the upstream field names and omits absent keys', () => {
    const [entry] = fleetRowsToJson([live])
    expect(entry).toEqual({
      id: 'sess-live',
      state: 'live',
      name: 'fixing the parser',
      kind: 'interactive',
      pid: 4242,
      sessionId: 'sess-live',
      cwd: '/repo/app',
      gitBranch: 'feature/x',
      status: 'busy',
      startedAt: 1000,
      lastActivityAt: 2000,
    })
    // Absent optionals are omitted, never null.
    expect(Object.keys(fleetRowsToJson([starting])[0] as object)).toEqual([
      'id',
      'state',
      'name',
      'pid',
    ])
  })

  test('drops ended rows unless --all', () => {
    expect(fleetRowsToJson([live, ended, starting]).map(e => e.id)).toEqual([
      'sess-live',
      'pid:99',
    ])
    expect(
      fleetRowsToJson([live, ended, starting], { all: true }).map(e => e.id),
    ).toEqual(['sess-live', 'sess-ended', 'pid:99'])
  })

  test('--cwd keeps the directory and its descendants only', () => {
    expect(
      fleetRowsToJson([live, ended], { all: true, cwd: '/repo/app' }).map(
        e => e.id,
      ),
    ).toEqual(['sess-live'])
    expect(
      fleetRowsToJson([live, ended], { all: true, cwd: '/repo' }).map(
        e => e.id,
      ),
    ).toEqual(['sess-live', 'sess-ended'])
    // A row with no cwd cannot satisfy a cwd filter.
    expect(fleetRowsToJson([starting], { cwd: '/repo' })).toEqual([])
  })

  test('output is JSON-serializable as an array', () => {
    expect(JSON.parse(JSON.stringify(fleetRowsToJson([live])))).toHaveLength(1)
  })
})

describe('isPathWithin', () => {
  test('matches the directory itself and its children', () => {
    expect(isPathWithin('/repo', '/repo')).toBe(true)
    expect(isPathWithin('/repo', '/repo/app')).toBe(true)
    expect(isPathWithin('/repo/', '/repo/app')).toBe(true)
  })

  test('does not match a sibling with a shared prefix', () => {
    // The bug a naive startsWith would have: /repo-two is not inside /repo.
    expect(isPathWithin('/repo', '/repo-two')).toBe(false)
  })
})
