/**
 * Team-lead inbox polling and swarm-shutdown detection for headless runs.
 *
 * Both were inline blocks at the tail of `runHeadlessStreaming`'s `run()`.
 * They are the only part of the turn loop that talks to the teammate
 * mailbox, so they get their own module; the turn loop keeps the control
 * flow (start a turn / close the stream) and calls these for the decision.
 */
import { randomUUID } from 'crypto'
import { TEAMMATE_MESSAGE_TAG } from 'src/constants/xml.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { enqueue } from 'src/utils/session/messageQueueManager.js'
import { sleep } from 'src/utils/process/sleep.js'
import {
  hasActiveInProcessTeammates,
  hasWorkingInProcessTeammates,
  isTeamLead,
  waitForTeammatesToBecomeIdle,
} from 'src/utils/teammate.js'
import {
  isShutdownApproved,
  markMessagesAsRead,
  readUnreadMessages,
} from 'src/utils/teammateMailbox.js'
import { removeTeammateFromTeamFile } from 'src/utils/swarm/teamHelpers.js'
import { unassignTeammateTasks } from 'src/utils/tasks.js'
import { SHUTDOWN_TEAM_PROMPT } from './runtime.js'
import type { HeadlessRunState } from './headlessRunState.js'

/**
 * Check the team-lead inbox and act on anything unread.
 *
 * Mirrors what useInboxPoller does in the interactive REPL: polls while
 * teammates are active, processes shutdown_approved by removing the teammate
 * from the team file / AppState and unassigning its tasks, then forwards the
 * remaining messages to the model as a prompt.
 *
 * Returns 'requeued' when it enqueued a prompt — the caller must start a turn
 * and return, exactly as the original `void run(); return` did. The enqueue
 * happens before the return either way, so ordering is unchanged.
 */
export async function pollTeamLeadInbox(
  state: HeadlessRunState,
): Promise<'idle' | 'requeued'> {
  const currentAppState = state.getAppState()
  const teamContext = currentAppState.teamContext

  if (teamContext && isTeamLead(teamContext)) {
    const agentName = 'team-lead'

    // Poll for messages while teammates are active
    // This is needed because teammates may send messages while we're waiting
    // Keep polling until the team is shut down
    const POLL_INTERVAL_MS = 500

    while (true) {
      // Check if teammates are still active
      const refreshedState = state.getAppState()
      const hasActiveTeammates =
        hasActiveInProcessTeammates(refreshedState) ||
        (refreshedState.teamContext &&
          Object.keys(refreshedState.teamContext.teammates).length > 0)

      if (!hasActiveTeammates) {
        logForDebugging('[print.ts] No more active teammates, stopping poll')
        break
      }

      const unread = await readUnreadMessages(
        agentName,
        refreshedState.teamContext?.teamName,
      )

      if (unread.length > 0) {
        logForDebugging(
          `[print.ts] Team-lead found ${unread.length} unread messages`,
        )

        // Mark as read immediately to avoid duplicate processing
        await markMessagesAsRead(
          agentName,
          refreshedState.teamContext?.teamName,
        )

        // Process shutdown_approved messages - remove teammates from team file
        // This mirrors what useInboxPoller does in interactive mode (lines 546-606)
        const teamName = refreshedState.teamContext?.teamName
        for (const m of unread) {
          const shutdownApproval = isShutdownApproved(m.text)
          if (shutdownApproval && teamName) {
            const teammateToRemove = shutdownApproval.from
            logForDebugging(
              `[print.ts] Processing shutdown_approved from ${teammateToRemove}`,
            )

            // Find the teammate ID by name
            const teammateId = refreshedState.teamContext?.teammates
              ? Object.entries(refreshedState.teamContext.teammates).find(
                  ([, t]) => t.name === teammateToRemove,
                )?.[0]
              : undefined

            if (teammateId) {
              // Remove from team file
              removeTeammateFromTeamFile(teamName, {
                agentId: teammateId,
                name: teammateToRemove,
              })
              logForDebugging(
                `[print.ts] Removed ${teammateToRemove} from team file`,
              )

              // Unassign tasks owned by this teammate
              await unassignTeammateTasks(
                teamName,
                teammateId,
                teammateToRemove,
                'shutdown',
              )

              // Remove from teamContext in AppState
              state.setAppState(prev => {
                if (!prev.teamContext?.teammates) return prev
                if (!(teammateId in prev.teamContext.teammates)) return prev
                const { [teammateId]: _, ...remainingTeammates } =
                  prev.teamContext.teammates
                return {
                  ...prev,
                  teamContext: {
                    ...prev.teamContext,
                    teammates: remainingTeammates,
                  },
                }
              })
            }
          }
        }

        // Format messages same as useInboxPoller
        const formatted = unread
          .map(
            (m: { from: string; text: string; color?: string }) =>
              `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${m.color ? ` color="${m.color}"` : ''}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`,
          )
          .join('\n\n')

        // Enqueue and process
        enqueue({
          mode: 'prompt',
          value: formatted,
          uuid: randomUUID(),
        })
        return 'requeued'
      }

      // No messages - check if we need to prompt for shutdown
      // If input is closed and teammates are active, inject shutdown prompt once
      if (state.inputClosed && !state.shutdownPromptInjected) {
        state.shutdownPromptInjected = true
        logForDebugging(
          '[print.ts] Input closed with active teammates, injecting shutdown prompt',
        )
        enqueue({
          mode: 'prompt',
          value: SHUTDOWN_TEAM_PROMPT,
          uuid: randomUUID(),
        })
        return 'requeued'
      }

      // Wait and check again
      await sleep(POLL_INTERVAL_MS)
    }
  }
  return 'idle'
}

/**
 * Whether input close should be answered with a team-shutdown prompt rather
 * than by closing the output stream. Waits for working in-process teammates
 * to go idle first, then re-reads state.
 */
export async function hasActiveSwarmNeedingShutdown(
  state: HeadlessRunState,
): Promise<boolean> {
  // Wait for any working in-process team members to finish
  const currentAppState = state.getAppState()
  if (hasWorkingInProcessTeammates(currentAppState)) {
    await waitForTeammatesToBecomeIdle(state.setAppState, currentAppState)
  }

  // Re-fetch state after potential wait
  const refreshedAppState = state.getAppState()
  const refreshedTeamContext = refreshedAppState.teamContext
  const hasTeamMembersNotCleanedUp =
    refreshedTeamContext &&
    Object.keys(refreshedTeamContext.teammates).length > 0

  return (
    hasTeamMembersNotCleanedUp || hasActiveInProcessTeammates(refreshedAppState)
  )
}
