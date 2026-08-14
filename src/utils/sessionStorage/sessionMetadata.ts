import type { UUID } from 'crypto'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getSessionId } from '../../bootstrap/state.js'
import { type SessionId } from '../../types/ids.js'
import {
  type GoalState,
  type PersistedWorktreeSession,
} from '../../types/logs.js'
import { updateSessionName } from '../session/concurrentSessions.js'
import { appendEntryToFile } from './fileIO.js'
import { getTranscriptPathForSession } from './paths.js'
import { getProject, project } from './transcriptWriter.js'

/* eslint-enable custom-rules/no-sync-fs */

export async function saveCustomTitle(
  sessionId: UUID,
  customTitle: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  // Fall back to computed path if fullPath is not provided
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'custom-title',
    customTitle,
    sessionId,
  })
  // Cache for current session only (for immediate visibility)
  if (sessionId === getSessionId()) {
    getProject().currentSessionTitle = customTitle
  }
  logEvent('tengu_session_renamed', {
    source:
      source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * Persist an AI-generated title to the JSONL as a distinct `ai-title` entry.
 *
 * Writing a separate entry type (vs. reusing `custom-title`) is load-bearing:
 * - Read preference: readers prefer `customTitle` field over `aiTitle`, so
 *   a user rename always wins regardless of append order.
 * - Resume safety: `loadTranscriptFile` only populates the `customTitles`
 *   Map from `custom-title` entries, so `restoreSessionMetadata` never
 *   caches an AI title and `reAppendSessionMetadata` never re-appends one
 *   at EOF — avoiding the clobber-on-resume bug where a stale AI title
 *   overwrites a mid-session user rename.
 * - CAS semantics: VS Code's `onlyIfNoCustomTitle` check scans for the
 *   `customTitle` field only, so AI can overwrite its own previous AI
 *   title but never a user title.
 * - Metrics: `tengu_session_renamed` is not fired for AI titles.
 *
 * Because the entry is never re-appended, it scrolls out of the 64KB tail
 * window once enough messages accumulate. Readers (`readLiteMetadata`,
 * `listSessionsImpl`, VS Code `fetchSessions`) fall back to scanning the
 * head buffer for `aiTitle` in that case. Both head and tail reads are
 * bounded (64KB each via `extractLastJsonStringField`), never a full scan.
 *
 * Callers with a stale-write guard (e.g., VS Code client) should prefer
 * passing `persist: false` to the SDK control request and persisting
 * through their own rename path after the guard passes, to avoid a race
 * where the AI title lands after a mid-flight user rename.
 */
export function saveAiGeneratedTitle(sessionId: UUID, aiTitle: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'ai-title',
    aiTitle,
    sessionId,
  })
}

/**
 * Append a periodic task summary for `claude ps`. Unlike ai-title this is
 * not re-appended by reAppendSessionMetadata — it's a rolling snapshot of
 * what the agent is doing *now*, so staleness is fine; ps reads the most
 * recent one from the tail.
 */
export function saveTaskSummary(sessionId: UUID, summary: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'task-summary',
    summary,
    sessionId,
    timestamp: new Date().toISOString(),
  })
}

export async function saveTag(sessionId: UUID, tag: string, fullPath?: string) {
  // Fall back to computed path if fullPath is not provided
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, { type: 'tag', tag, sessionId })
  // Cache for current session only (for immediate visibility)
  if (sessionId === getSessionId()) {
    getProject().currentSessionTag = tag
  }
  logEvent('tengu_session_tagged', {})
}

/**
 * Persist a goal-state checkpoint to the JSONL transcript. Called by
 * src/services/goal/goalStorage.ts on every mutation. The latest entry
 * wins on read; older entries are harmlessly ignored.
 *
 * Cached on Project so reAppendSessionMetadata can keep the goal alive
 * past compaction's tail-read window.
 */
export function saveGoal(
  sessionId: UUID,
  state: GoalState,
  fullPath?: string,
): void {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'goal',
    sessionId,
    state,
    timestamp: new Date().toISOString(),
  })
  if (sessionId === getSessionId()) {
    getProject().currentSessionGoal = state
  }
}

/**
 * Record that this run already offered to auto-continue the interrupted turn
 * ending at `resumeAnchorUuid`.
 *
 * Written the moment the offer is acted on, not when it finishes: the case
 * this protects against is the run dying before it writes anything, which is
 * exactly when a completion-time write would never happen. If the run does
 * produce messages the transcript tail moves past the anchor and the entry
 * stops matching on its own — no tombstone needed.
 *
 * Not cached on Project and not re-appended by reAppendSessionMetadata: unlike
 * a title or a goal, a stale anchor pushed past a compaction boundary is
 * harmless (it just stops suppressing), while a re-appended one could outlive
 * the tail it describes.
 */
export function saveResumeAnchor(
  sessionId: UUID,
  resumeAnchorUuid: UUID,
  fullPath?: string,
): void {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'resume-anchor',
    sessionId,
    resumeAnchorUuid,
  })
}

/**
 * Persist a "goal cleared" tombstone so a future --resume cannot
 * resurrect the goal from a prior `goal` entry. Also drops the
 * in-memory cache for the current session.
 */
export function clearGoalEntry(sessionId: UUID, fullPath?: string): void {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'goal-cleared',
    sessionId,
    timestamp: new Date().toISOString(),
  })
  if (sessionId === getSessionId()) {
    getProject().currentSessionGoal = undefined
  }
}

/**
 * Link a session to a GitHub pull request.
 * This stores the PR number, URL, and repository for tracking and navigation.
 */
export async function linkSessionToPR(
  sessionId: UUID,
  prNumber: number,
  prUrl: string,
  prRepository: string,
  fullPath?: string,
): Promise<void> {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'pr-link',
    sessionId,
    prNumber,
    prUrl,
    prRepository,
    timestamp: new Date().toISOString(),
  })
  // Cache for current session so reAppendSessionMetadata can re-write after compaction
  if (sessionId === getSessionId()) {
    const project = getProject()
    project.currentSessionPrNumber = prNumber
    project.currentSessionPrUrl = prUrl
    project.currentSessionPrRepository = prRepository
  }
  logEvent('tengu_session_linked_to_pr', { prNumber })
}

export function getCurrentSessionTag(sessionId: UUID): string | undefined {
  // Only returns tag for current session (the only one we cache)
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTag
  }
  return undefined
}

export function getCurrentSessionTitle(
  sessionId: SessionId,
): string | undefined {
  // Only returns title for current session (the only one we cache)
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTitle
  }
  return undefined
}

export function getCurrentSessionAgentColor(): string | undefined {
  return getProject().currentSessionAgentColor
}

/**
 * Restore session metadata into in-memory cache on resume.
 * Populates the cache so metadata is available for display (e.g. the
 * agent banner) and re-appended on session exit via reAppendSessionMetadata.
 */
export function restoreSessionMetadata(meta: {
  customTitle?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
  goal?: GoalState
}): void {
  const project = getProject()
  // ??= so --name (cacheSessionTitle) wins over the resumed
  // session's title. REPL.tsx clears before calling, so /resume is unaffected.
  if (meta.customTitle) project.currentSessionTitle ??= meta.customTitle
  if (meta.tag !== undefined) project.currentSessionTag = meta.tag || undefined
  if (meta.agentName) project.currentSessionAgentName = meta.agentName
  if (meta.agentColor) project.currentSessionAgentColor = meta.agentColor
  if (meta.agentSetting) project.currentSessionAgentSetting = meta.agentSetting
  if (meta.mode) project.currentSessionMode = meta.mode
  if (meta.worktreeSession !== undefined)
    project.currentSessionWorktree = meta.worktreeSession
  if (meta.prNumber !== undefined)
    project.currentSessionPrNumber = meta.prNumber
  if (meta.prUrl) project.currentSessionPrUrl = meta.prUrl
  if (meta.prRepository) project.currentSessionPrRepository = meta.prRepository
  if (meta.goal) project.currentSessionGoal = meta.goal
}

/**
 * Clear all cached session metadata (title, tag, agent name/color).
 * Called when /clear creates a new session so stale metadata
 * from the previous session does not leak into the new one.
 */
export function clearSessionMetadata(): void {
  const project = getProject()
  project.currentSessionTitle = undefined
  project.currentSessionTag = undefined
  project.currentSessionAgentName = undefined
  project.currentSessionAgentColor = undefined
  project.currentSessionLastPrompt = undefined
  project.currentSessionAgentSetting = undefined
  project.currentSessionMode = undefined
  project.currentSessionGoal = undefined
  project.currentSessionWorktree = undefined
  project.currentSessionPrNumber = undefined
  project.currentSessionPrUrl = undefined
  project.currentSessionPrRepository = undefined
}

/**
 * Re-append cached session metadata (custom title, tag) to the end of the
 * transcript file. Call this after compaction so the metadata stays within
 * the 16KB tail window that readLiteMetadata reads during progressive loading.
 * Without this, enough post-compaction messages can push the metadata entry
 * out of the window, causing `--resume` to show the auto-generated firstPrompt
 * instead of the user-set session name.
 */
export function reAppendSessionMetadata(): void {
  getProject().reAppendSessionMetadata()
}

export async function saveAgentName(
  sessionId: UUID,
  agentName: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, { type: 'agent-name', agentName, sessionId })
  // Cache for current session only (for immediate visibility)
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentName = agentName
    void updateSessionName(agentName)
  }
  logEvent('tengu_agent_name_set', {
    source:
      source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

export async function saveAgentColor(
  sessionId: UUID,
  agentColor: string,
  fullPath?: string,
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'agent-color',
    agentColor,
    sessionId,
  })
  // Cache for current session only (for immediate visibility)
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentColor = agentColor
  }
  logEvent('tengu_agent_color_set', {})
}

/**
 * Cache the session agent setting. Written to disk by materializeSessionFile
 * on the first user message, and re-stamped by reAppendSessionMetadata on exit.
 * Cache-only here to avoid creating metadata-only session files at startup.
 */
export function saveAgentSetting(agentSetting: string): void {
  getProject().currentSessionAgentSetting = agentSetting
}

/**
 * Cache a session title set at startup (--name). Written to disk by
 * materializeSessionFile on the first user message. Cache-only here so no
 * orphan metadata-only file is created before the session ID is finalized.
 */
export function cacheSessionTitle(customTitle: string): void {
  getProject().currentSessionTitle = customTitle
}

/**
 * Cache the session mode. Written to disk by materializeSessionFile on the
 * first user message, and re-stamped by reAppendSessionMetadata on exit.
 * Cache-only here to avoid creating metadata-only session files at startup.
 */
export function saveMode(mode: 'coordinator' | 'normal'): void {
  getProject().currentSessionMode = mode
}

/**
 * Record the session's worktree state for --resume. Written to disk by
 * materializeSessionFile on the first user message and re-stamped by
 * reAppendSessionMetadata on exit. Pass null when exiting a worktree
 * so --resume knows not to cd back into it.
 */
export function saveWorktreeState(
  worktreeSession: PersistedWorktreeSession | null,
): void {
  // Strip ephemeral fields (creationDurationMs, usedSparsePaths) that callers
  // may pass via full WorktreeSession objects — TypeScript structural typing
  // allows this, but we don't want them serialized to the transcript.
  const stripped: PersistedWorktreeSession | null = worktreeSession
    ? {
        originalCwd: worktreeSession.originalCwd,
        worktreePath: worktreeSession.worktreePath,
        worktreeName: worktreeSession.worktreeName,
        worktreeBranch: worktreeSession.worktreeBranch,
        originalBranch: worktreeSession.originalBranch,
        originalHeadCommit: worktreeSession.originalHeadCommit,
        sessionId: worktreeSession.sessionId,
        tmuxSessionName: worktreeSession.tmuxSessionName,
        hookBased: worktreeSession.hookBased,
      }
    : null
  const project = getProject()
  project.currentSessionWorktree = stripped
  // Write eagerly when the file already exists (mid-session enter/exit).
  // For --worktree startup, sessionFile is null — materializeSessionFile
  // will write it on the first message via reAppendSessionMetadata.
  if (project.sessionFile) {
    appendEntryToFile(project.sessionFile, {
      type: 'worktree-state',
      worktreeSession: stripped,
      sessionId: getSessionId(),
    })
  }
}
