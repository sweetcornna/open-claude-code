import { createAbortController } from '../../utils/abortController.js'
import { createUserMessage } from '../../utils/messages.js'
import { enqueue, getCommandQueue } from '../../utils/messageQueueManager.js'
import {
  claimConsumableQueuedAutonomyCommands,
  finalizeAutonomyCommandsForTurn,
} from '../../utils/autonomyQueueLifecycle.js'
import { getCwd } from '../../utils/filesystem/cwd.js'
import { logError } from '../../utils/log.js'
import { toError } from '../../utils/errors.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import type { Message as MessageType } from '../../types/message.js'
import type { QueryGuard } from '../../utils/QueryGuard.js'

/** Everything REPL's `handleIncomingPrompt` closure captured. */
export type IncomingPromptContext = {
  mainLoopModel: string
  onQuery: (
    newMessages: MessageType[],
    abortController: AbortController,
    shouldQuery: boolean,
    additionalAllowedTools: string[],
    mainLoopModelParam: string,
  ) => Promise<boolean | undefined>
  queryGuard: QueryGuard
  setAbortController: (controller: AbortController | null) => void
}

/**
 * Body of REPL's `handleIncomingPrompt` useCallback, moved out verbatim. The
 * useCallback wrapper and its `[onQuery, mainLoopModel, store]` dep array stay
 * in REPL.tsx, so the hook call order is untouched.
 */
export function runIncomingPrompt(
  input: string | QueuedCommand,
  options: { isMeta?: boolean } | undefined,
  ctx: IncomingPromptContext,
): boolean {
  const { mainLoopModel, onQuery, queryGuard, setAbortController } = ctx
  if (queryGuard.isActive) return false

  // Defer to user-queued commands — user input always takes priority
  // over system messages (teammate messages, task list items, etc.)
  // Read from the module-level store at call time (not the render-time
  // snapshot) to avoid a stale closure — this callback's deps don't
  // include the queue.
  if (
    getCommandQueue().some(cmd => cmd.mode === 'prompt' || cmd.mode === 'bash')
  ) {
    return false
  }

  const queuedCommand =
    typeof input === 'string'
      ? ({
          value: input,
          mode: 'prompt',
          isMeta: options?.isMeta ? true : undefined,
        } satisfies QueuedCommand)
      : input

  void (async () => {
    const claim = await claimConsumableQueuedAutonomyCommands([queuedCommand])
    const command = claim.attachmentCommands[0]
    if (!command) return

    const newAbortController = createAbortController()
    setAbortController(newAbortController)

    // Create a user message with the formatted content (includes XML wrapper)
    const userMessage = createUserMessage({
      content: command.value,
      isMeta: command.isMeta ? true : undefined,
      origin: command.origin,
    })

    let executed = false
    try {
      executed =
        (await onQuery(
          [userMessage],
          newAbortController,
          true,
          [],
          mainLoopModel,
        )) !== false
    } catch (error: unknown) {
      try {
        await finalizeAutonomyCommandsForTurn({
          commands: claim.claimedCommands,
          outcome: { type: 'failed', error },
          currentDir: getCwd(),
          priority: 'later',
        })
      } catch (finalizeError: unknown) {
        logError(toError(finalizeError))
      }
      logError(toError(error))
      return
    }

    // Only finalize as completed when onQuery actually executed the turn
    // (it returns false from the concurrent-guard path without running).
    // Keep this finalize in its own try/catch so a failure here does not
    // trigger a second finalize as `failed` for the same commands.
    if (!executed) {
      return
    }
    try {
      const nextCommands = await finalizeAutonomyCommandsForTurn({
        commands: claim.claimedCommands,
        outcome: { type: 'completed' },
        currentDir: getCwd(),
        priority: 'later',
      })
      for (const nextCommand of nextCommands) {
        enqueue(nextCommand)
      }
    } catch (finalizeError: unknown) {
      logError(toError(finalizeError))
    }
  })().catch((error: unknown) => {
    logError(toError(error))
  })
  return true
}
