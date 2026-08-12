/**
 * FleetView's data feed: poll the PID registry and the transcript index, join
 * them, and hand the component a sorted, grouped row list.
 *
 * Both sources are consumed read-only — `concurrentSessions.ts` and
 * `listSessionsImpl.ts` are not modified by this feature. All of the logic with
 * rules in it lives in `fleetRows.ts` (zero imports, zero mocks in its tests);
 * this file is only the effect wrapper.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { homedir } from 'os'
import { listAllLiveSessions } from '../../utils/session/concurrentSessions.js'
import { listSessionsImpl } from '../../utils/session/listSessionsImpl.js'
import {
  type FleetGroup,
  type FleetRow,
  groupRowsByProject,
  joinFleetRows,
} from './fleetRows.js'

/** The official view polls at the same cadence. */
const FLEET_POLL_INTERVAL_MS = 2000

/**
 * Transcript budget per poll.
 *
 * `listSessionsImpl` with a limit does a cheap stat-only pass over every
 * candidate and only reads head/tail for the newest `limit` of them, so the
 * per-poll cost is bounded by this number rather than by how many sessions the
 * user has ever started. Live sessions are by construction among the most
 * recently touched, so the join still finds their transcripts.
 */
const FLEET_TRANSCRIPT_LIMIT = 60

type FleetSessionsState = {
  rows: FleetRow[]
  groups: FleetGroup[]
  /** True until the first poll resolves — distinguishes "empty" from "not yet". */
  loading: boolean
  error?: string
  refresh: () => void
}

async function loadFleetRows(): Promise<FleetRow[]> {
  const [liveSessions, transcripts] = await Promise.all([
    listAllLiveSessions(),
    listSessionsImpl({ limit: FLEET_TRANSCRIPT_LIMIT }),
  ])
  return joinFleetRows(liveSessions, transcripts)
}

export function useFleetSessions(options?: {
  pollIntervalMs?: number
  currentCwd?: string
}): FleetSessionsState {
  const intervalMs = options?.pollIntervalMs ?? FLEET_POLL_INTERVAL_MS
  const currentCwd = options?.currentCwd
  const [rows, setRows] = useState<FleetRow[]>([])
  const [groups, setGroups] = useState<FleetGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)

  // A slow poll must not stack behind the next tick, and a poll that resolves
  // after unmount must not setState.
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const [refreshToken, setRefreshToken] = useState(0)

  const refresh = useCallback(() => {
    setRefreshToken(token => token + 1)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const home = homedir()

    async function poll(): Promise<void> {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const next = await loadFleetRows()
        if (!mounted.current) return
        setRows(next)
        setGroups(groupRowsByProject(next, { currentCwd, home }))
        setError(undefined)
      } catch (e) {
        if (!mounted.current) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        inFlight.current = false
        if (mounted.current) setLoading(false)
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, currentCwd, refreshToken])

  return { rows, groups, loading, error, refresh }
}
