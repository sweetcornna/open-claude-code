/**
 * The FleetView data load, extracted from `useFleetSessions` so the headless
 * `occ agents --json` path can reuse it without importing React/Ink.
 *
 * Both sources are consumed read-only — `concurrentSessions.ts` (the PID
 * registry) and `listSessionsImpl.ts` (the transcript index). All of the logic
 * with rules in it stays in `fleetRows.ts`.
 */

import { listAllLiveSessions } from '../../utils/session/concurrentSessions.js'
import { listSessionsImpl } from '../../utils/session/listSessionsImpl.js'
import { type FleetRow, joinFleetRows } from './fleetRows.js'

/**
 * Transcript budget per load.
 *
 * `listSessionsImpl` with a limit does a cheap stat-only pass over every
 * candidate and only reads head/tail for the newest `limit` of them, so the
 * per-poll cost is bounded by this number rather than by how many sessions the
 * user has ever started. Live sessions are by construction among the most
 * recently touched, so the join still finds their transcripts.
 */
export const FLEET_TRANSCRIPT_LIMIT = 60

export async function loadFleetRows(): Promise<FleetRow[]> {
  const [liveSessions, transcripts] = await Promise.all([
    listAllLiveSessions(),
    listSessionsImpl({ limit: FLEET_TRANSCRIPT_LIMIT }),
  ])
  return joinFleetRows(liveSessions, transcripts)
}
