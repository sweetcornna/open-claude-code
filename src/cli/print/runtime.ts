import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'

// Dead code elimination: conditional imports
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js'))
  : null
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../../proactive/index.js') as typeof import('../../proactive/index.js'))
    : null
const cronSchedulerModule =
  require('../../utils/task/cronScheduler.js') as typeof import('../../utils/task/cronScheduler.js')
const cronJitterConfigModule =
  require('../../utils/task/cronJitterConfig.js') as typeof import('../../utils/task/cronJitterConfig.js')
const cronGate =
  require('@open-claude-code/builtin-tools/tools/ScheduleCronTool/prompt.js') as typeof import('@open-claude-code/builtin-tools/tools/ScheduleCronTool/prompt.js')
/* eslint-enable @typescript-eslint/no-require-imports */

const SHUTDOWN_TEAM_PROMPT = `<system-reminder>
You are running in non-interactive mode and cannot return a response to the user until your team is shut down.

You MUST shut down your team before preparing your final response:
1. Use requestShutdown to ask each team member to shut down gracefully
2. Wait for shutdown approvals
3. Use the cleanup operation to clean up the team
4. Only then provide your final response to the user

The user cannot receive your response until the team is completely shut down.
</system-reminder>

Shut down your team and prepare your final response for the user.`

// Track message UUIDs received during the current session runtime
const MAX_RECEIVED_UUIDS = 10_000
const receivedMessageUuids = new Set<UUID>()
const receivedMessageUuidsOrder: UUID[] = []

function trackReceivedMessageUuid(uuid: UUID): boolean {
  if (receivedMessageUuids.has(uuid)) {
    return false // duplicate
  }
  receivedMessageUuids.add(uuid)
  receivedMessageUuidsOrder.push(uuid)
  // Evict oldest entries when at capacity
  if (receivedMessageUuidsOrder.length > MAX_RECEIVED_UUIDS) {
    const toEvict = receivedMessageUuidsOrder.splice(
      0,
      receivedMessageUuidsOrder.length - MAX_RECEIVED_UUIDS,
    )
    for (const old of toEvict) {
      receivedMessageUuids.delete(old)
    }
  }
  return true // new UUID
}

export {
  coordinatorModeModule,
  proactiveModule,
  cronSchedulerModule,
  cronJitterConfigModule,
  cronGate,
  SHUTDOWN_TEAM_PROMPT,
  receivedMessageUuids,
  trackReceivedMessageUuid,
}
