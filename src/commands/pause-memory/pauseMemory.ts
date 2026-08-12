import { toggleMemoryPaused } from '../../memdir/memoryPause.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalCommandResult } from '../../types/command.js'

const PAUSED_MESSAGE = [
  'Memory paused for this session · this conversation will not write or read new memories,',
  'and previously-loaded memory content should not be referenced.',
  '',
  'Run /pause-memory again to resume.',
].join('\n')

const RESUMED_MESSAGE =
  'Memory resumed · memory content may be referenced and new memories can be saved.'

export async function call(): Promise<LocalCommandResult> {
  const paused = toggleMemoryPaused()
  logEvent('tengu_memory_toggled', { toggled_off: paused })
  return {
    type: 'text',
    value: paused ? PAUSED_MESSAGE : RESUMED_MESSAGE,
  }
}
