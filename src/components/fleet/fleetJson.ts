/**
 * `occ agents --json` — the scriptable projection of the FleetView row model.
 *
 * Upstream Claude Code exposes the same listing as a JSON array (one object per
 * agent/session) and, unlike the interactive list, does NOT require a TTY: it
 * is the machine-readable half of `claude agents`. occ's row model is its own
 * join (see `fleetRows.ts`), so the field set is a superset of upstream's
 * `{pid,id,cwd,kind,startedAt,sessionId,name,status,state}` rather than a
 * byte-for-byte copy — `gitBranch` and `lastActivityAt` come from the
 * transcript side of the join and have no upstream equivalent.
 *
 * Deliberately zero imports beyond the row types: this is pure shaping, so its
 * tests need no mocks and no filesystem.
 */

import type { FleetRow, FleetRowState } from './fleetRows.js'

/** One entry of the `occ agents --json` array. */
export type FleetJsonEntry = {
  id: string
  state: FleetRowState
  name: string
  kind?: string
  pid?: number
  sessionId?: string
  cwd?: string
  gitBranch?: string
  status?: string
  waitingFor?: string
  startedAt?: number
  lastActivityAt?: number
}

export type FleetJsonFilter = {
  /** Include `ended` (resumable, no live process) rows. Default: false. */
  all?: boolean
  /** Restrict to rows whose cwd is this directory or below it. */
  cwd?: string
}

/**
 * True when `child` is `parent` or lives under it.
 *
 * String-prefix comparison on purpose: the caller resolves both sides, and a
 * separator guard keeps `/a/bc` from matching a `/a/b` filter.
 */
export function isPathWithin(parent: string, child: string): boolean {
  if (parent === child) return true
  const normalized = parent.replace(/[/\\]+$/, '')
  return (
    child.startsWith(`${normalized}/`) || child.startsWith(`${normalized}\\`)
  )
}

/**
 * Project rows onto the JSON shape.
 *
 * Optional keys are omitted rather than emitted as `null` so consumers can use
 * plain `in`/`??` checks; `id`, `state` and `name` are always present because
 * every row has them by construction.
 */
export function fleetRowsToJson(
  rows: readonly FleetRow[],
  filter: FleetJsonFilter = {},
): FleetJsonEntry[] {
  const entries: FleetJsonEntry[] = []
  for (const row of rows) {
    if (!filter.all && row.state === 'ended') continue
    if (filter.cwd && (!row.cwd || !isPathWithin(filter.cwd, row.cwd))) continue
    entries.push({
      id: row.id,
      state: row.state,
      name: row.label,
      ...(row.kind !== undefined && { kind: row.kind }),
      ...(row.pid !== undefined && { pid: row.pid }),
      ...(row.sessionId !== undefined && { sessionId: row.sessionId }),
      ...(row.cwd !== undefined && { cwd: row.cwd }),
      ...(row.gitBranch !== undefined && { gitBranch: row.gitBranch }),
      ...(row.status !== undefined && { status: row.status }),
      ...(row.waitingFor !== undefined && { waitingFor: row.waitingFor }),
      ...(row.startedAt !== undefined && { startedAt: row.startedAt }),
      ...(row.lastActivityAt !== undefined && {
        lastActivityAt: row.lastActivityAt,
      }),
    })
  }
  return entries
}
