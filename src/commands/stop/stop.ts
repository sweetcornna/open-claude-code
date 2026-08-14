import type * as React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import { jobIdFromSessionName, markJobTerminal } from '../../cli/bg/jobStore.js'
import { BIN_NAME } from '../../constants/brand.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { gracefulShutdown } from '../../utils/process/gracefulShutdown.js'
import { getBgSessionMetadata } from '../../utils/session/concurrentSessions.js'
import { logForDebugging } from '../../utils/telemetry/debug.js'

/**
 * Write the same terminal job record `occ stop <id>` writes from the outside
 * (`cli/bg.ts`'s recordTermination). Without it the process just disappears and
 * `occ daemon status` keeps describing the job as running.
 *
 * Best-effort and separated from `call()` so it is testable: `call()` ends in
 * gracefulShutdown, which a test cannot survive.
 *
 * Returns the job id it marked, or undefined when this session has none —
 * markJobTerminal itself no-ops on a missing record, and sessions started
 * before the job store existed have no record at all.
 */
export async function recordStopped(): Promise<string | undefined> {
  const jobId = jobIdFromSessionName(getBgSessionMetadata().name)
  if (!jobId) return undefined
  try {
    const record = await markJobTerminal(jobId, {
      state: 'stopped',
      detail: 'stopped from session',
    })
    return record ? jobId : undefined
  } catch (error) {
    logForDebugging(`/stop: could not mark job ${jobId} terminal: ${error}`)
    return undefined
  }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode> {
  await recordStopped()
  onDone(
    `Session stopped. Resume it with \`${BIN_NAME} --resume ${getSessionId()}\`.`,
  )
  await gracefulShutdown(0, 'prompt_input_exit')
  return null
}
