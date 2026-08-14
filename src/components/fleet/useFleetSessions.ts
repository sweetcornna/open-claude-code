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
import {
  type FleetGroup,
  type FleetRow,
  groupRowsByProject,
} from './fleetRows.js'
// The load itself lives outside this file so `occ agents --json` can run it
// without pulling React in. Keep both surfaces on the same function.
import { loadFleetRows } from './loadFleetRows.js'

/** The official view polls at the same cadence. */
const FLEET_POLL_INTERVAL_MS = 2000

type FleetSessionsState = {
  rows: FleetRow[]
  groups: FleetGroup[]
  /** True until the first poll resolves — distinguishes "empty" from "not yet". */
  loading: boolean
  error?: string
  refresh: () => void
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
