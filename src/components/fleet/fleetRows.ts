/**
 * Pure row model for FleetView — the join of occ's two session tables.
 *
 * occ keeps "who is alive" in `<occConfigDir>/sessions/<pid>.json` (the PID
 * registry) and "what was done" in the JSONL transcripts under
 * `<occConfigDir>/projects/` (the session index). Nothing in the repo joined
 * them before; FleetView is that join, and this file is the half with rules.
 *
 * Deliberately zero imports. The cycle ratchet (`bun run check:cycles`) is
 * two-directional and counts type-only edges in its `total` budget, so the two
 * upstream shapes are re-declared structurally instead of imported:
 * `PeerSession` (concurrentSessions.ts) and `SessionInfo` (listSessionsImpl.ts)
 * are assignable to them. Zero imports also means the unit tests need zero
 * mocks.
 */

/**
 * Three states, from the join itself:
 *   live     — a running process whose transcript is on disk
 *   starting — a running process with no transcript yet (just spawned)
 *   ended    — a transcript with no running process (resumable)
 */
export type FleetRowState = 'live' | 'starting' | 'ended'

/** Structural subset of `PeerSession` from the PID registry. */
export type FleetLiveSession = {
  pid: number
  sessionId?: string
  cwd?: string
  startedAt?: number
  kind?: string
  name?: string
  status?: string
  waitingFor?: string
}

/** Structural subset of `SessionInfo` from the transcript index. */
export type FleetTranscript = {
  sessionId: string
  summary?: string
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  lastModified?: number
  createdAt?: number
}

export type FleetRow = {
  /** Stable list key. Session id when known, else the PID slot. */
  id: string
  state: FleetRowState
  label: string
  sessionId?: string
  pid?: number
  cwd?: string
  gitBranch?: string
  kind?: string
  /** Live activity pushed by the session itself (busy/idle/waiting). */
  status?: string
  waitingFor?: string
  /** Process start time — the age source for live/starting rows. */
  startedAt?: number
  /** Transcript mtime — the age source for ended rows. */
  lastActivityAt?: number
}

export type FleetGroup = {
  /** Working directory the rows share. Empty string when unknown. */
  cwd: string
  label: string
  rows: FleetRow[]
}

/** Shown when neither table has a usable title. Matches the official label. */
export const UNTITLED_SESSION_LABEL = 'new session'

const STATE_RANK: Record<FleetRowState, number> = {
  live: 0,
  starting: 1,
  ended: 2,
}

/**
 * Collapse every run of whitespace to a single space.
 *
 * Labels come from transcript prompts and summaries, which routinely contain
 * newlines. A raw newline inside a row makes Ink lay the row out over two
 * lines, which desynchronises the list from the selection index.
 */
function normalizeLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function firstNonEmpty(
  ...candidates: Array<string | undefined>
): string | undefined {
  for (const candidate of candidates) {
    const normalized = candidate ? normalizeLabel(candidate) : ''
    if (normalized) return normalized
  }
  return undefined
}

/**
 * Label priority: the name the user set on the live session wins over anything
 * derived from the transcript, because it is the only field they typed on
 * purpose. Then the transcript's own title chain, then the first prompt.
 */
function resolveLabel(
  live: FleetLiveSession | undefined,
  transcript: FleetTranscript | undefined,
): string {
  return (
    firstNonEmpty(
      live?.name,
      transcript?.customTitle,
      transcript?.summary,
      transcript?.firstPrompt,
    ) ?? UNTITLED_SESSION_LABEL
  )
}

/** Most recent timestamp known for a row, used for recency ordering. */
function recencyOf(row: FleetRow): number {
  return Math.max(row.startedAt ?? 0, row.lastActivityAt ?? 0)
}

/**
 * Join the PID registry against the transcript index on `sessionId`.
 *
 * Live sessions without a `sessionId` still get a row (keyed by PID) — a
 * session that has registered but not yet published its id is exactly the
 * `starting` case, and dropping it would make a just-spawned session invisible.
 */
export function joinFleetRows(
  liveSessions: readonly FleetLiveSession[],
  transcripts: readonly FleetTranscript[],
): FleetRow[] {
  const byId = new Map<string, FleetTranscript>()
  for (const transcript of transcripts) {
    if (!transcript.sessionId) continue
    const existing = byId.get(transcript.sessionId)
    // Duplicate ids can appear when the same session is indexed under two
    // project directories (worktrees). Keep the most recently touched copy.
    if (
      !existing ||
      (transcript.lastModified ?? 0) > (existing.lastModified ?? 0)
    ) {
      byId.set(transcript.sessionId, transcript)
    }
  }

  const rows: FleetRow[] = []
  const claimed = new Set<string>()

  for (const live of liveSessions) {
    const transcript = live.sessionId ? byId.get(live.sessionId) : undefined
    if (live.sessionId && transcript) claimed.add(live.sessionId)
    rows.push({
      id: live.sessionId ?? `pid:${live.pid}`,
      state: transcript ? 'live' : 'starting',
      label: resolveLabel(live, transcript),
      sessionId: live.sessionId,
      pid: live.pid,
      cwd: live.cwd ?? transcript?.cwd,
      gitBranch: transcript?.gitBranch,
      kind: live.kind,
      status: live.status,
      waitingFor: live.waitingFor,
      startedAt: live.startedAt,
      lastActivityAt: transcript?.lastModified,
    })
  }

  for (const transcript of byId.values()) {
    if (claimed.has(transcript.sessionId)) continue
    rows.push({
      id: transcript.sessionId,
      state: 'ended',
      label: resolveLabel(undefined, transcript),
      sessionId: transcript.sessionId,
      cwd: transcript.cwd,
      gitBranch: transcript.gitBranch,
      startedAt: transcript.createdAt,
      lastActivityAt: transcript.lastModified,
    })
  }

  return sortFleetRows(rows)
}

/**
 * Running processes first, then the resumable history, each most-recent-first.
 * `id` breaks ties so the 2s poll cannot reorder rows under the cursor.
 */
export function sortFleetRows(rows: readonly FleetRow[]): FleetRow[] {
  return [...rows].sort((a, b) => {
    const rank = STATE_RANK[a.state] - STATE_RANK[b.state]
    if (rank !== 0) return rank
    const recency = recencyOf(b) - recencyOf(a)
    if (recency !== 0) return recency
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Replace a leading home directory with `~`. Purely cosmetic; the row keeps the
 * real path so actions still spawn in the right directory.
 */
export function shortenProjectPath(path: string, home?: string): string {
  if (!home) return path
  if (path === home) return '~'
  const prefix = home.endsWith('/') || home.endsWith('\\') ? home : `${home}/`
  if (path.startsWith(prefix)) return `~/${path.slice(prefix.length)}`
  const winPrefix = `${home}\\`
  if (path.startsWith(winPrefix)) return `~\\${path.slice(winPrefix.length)}`
  return path
}

/**
 * Group rows by working directory — the official view uses `cwd` as a group
 * heading rather than a row column, and so does this one.
 *
 * The group containing `currentCwd` is pinned first; the rest follow their most
 * recent row. Row order inside a group is the order given.
 */
export function groupRowsByProject(
  rows: readonly FleetRow[],
  options?: { currentCwd?: string; home?: string },
): FleetGroup[] {
  const groups = new Map<string, FleetGroup>()
  for (const row of rows) {
    const cwd = row.cwd ?? ''
    let group = groups.get(cwd)
    if (!group) {
      group = {
        cwd,
        label: cwd ? shortenProjectPath(cwd, options?.home) : 'unknown project',
        rows: [],
      }
      groups.set(cwd, group)
    }
    group.rows.push(row)
  }

  const current = options?.currentCwd
  return [...groups.values()].sort((a, b) => {
    if (current) {
      if (a.cwd === current && b.cwd !== current) return -1
      if (b.cwd === current && a.cwd !== current) return 1
    }
    const aBest = a.rows.length ? recencyOf(a.rows[0]!) : 0
    const bBest = b.rows.length ? recencyOf(b.rows[0]!) : 0
    if (aBest !== bBest) return bBest - aBest
    return a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0
  })
}

/**
 * Milliseconds a row has been in its current life, or undefined when neither
 * table carried a timestamp. Ended rows age from their last transcript write;
 * running ones from process start.
 */
export function fleetRowAgeMs(row: FleetRow, now: number): number | undefined {
  const base =
    row.state === 'ended'
      ? (row.lastActivityAt ?? row.startedAt)
      : (row.startedAt ?? row.lastActivityAt)
  if (base === undefined) return undefined
  return Math.max(0, now - base)
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Highest significant unit only (`45s`, `3m`, `2h`, `9d`) — the official row
 * renderer's `formatJobAge`. A second unit would not fit the right-hand column.
 */
export function formatAge(ms: number): string {
  const clamped = Math.max(0, ms)
  if (clamped < MINUTE) return `${Math.floor(clamped / SECOND)}s`
  if (clamped < HOUR) return `${Math.floor(clamped / MINUTE)}m`
  if (clamped < DAY) return `${Math.floor(clamped / HOUR)}h`
  return `${Math.floor(clamped / DAY)}d`
}

/**
 * Right-hand status text. `waitingFor` outranks `status` because "waiting on
 * X" is the only state the user can act on.
 */
export function describeFleetRowState(row: FleetRow): string {
  if (row.state === 'ended') return 'ended'
  if (row.state === 'starting') return 'starting'
  if (row.waitingFor) return `waiting · ${row.waitingFor}`
  return row.status ?? 'running'
}

/** Whether a row can be resumed (`Enter` opens `--resume`) rather than attached. */
export function isResumableRow(row: FleetRow): boolean {
  return row.state === 'ended' && Boolean(row.sessionId)
}

/**
 * Whether `Enter` can hand this row the terminal.
 *
 * Only background sessions can: they are the ones started through `BgEngine`,
 * which is what gives them a tmux pane or a managed log file for
 * `src/cli/bg.ts` to reconnect to. An ordinary interactive session running in
 * another terminal has neither — attaching to it would only ever report that it
 * has no log path — and resuming its transcript in a second process while the
 * first is still writing to it is worse than doing nothing.
 */
export function isAttachableRow(row: FleetRow): boolean {
  return row.state !== 'ended' && row.kind === 'bg'
}

/**
 * The token `src/cli/bg.ts#findSession` matches on. It accepts a session id, a
 * PID or a name; the session id is preferred because PIDs get reused, and the
 * PID slot is only reachable for a row that has no id yet.
 */
export function fleetRowTarget(row: FleetRow): string | undefined {
  if (row.sessionId) return row.sessionId
  return row.pid === undefined ? undefined : String(row.pid)
}
