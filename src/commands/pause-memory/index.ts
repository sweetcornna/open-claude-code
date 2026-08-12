import type { Command } from '../../types/command.js'

/**
 * `/pause-memory` — suspend automemory for this session only.
 *
 * Toggle, not a one-way switch: running it again resumes. The state is
 * in-memory (see memdir/memoryPause.ts), so a new session always starts with
 * memory active.
 *
 * Deliberately NOT gated on `isAutoMemoryEnabled()`. Reaching memdir/paths.ts
 * from a module in the commands.ts import subtree closes a type-graph cycle
 * (`bun run check:cycles` goes +1, and the ratchet is two-way strict) — and it
 * buys nothing: when automemory is already off, the read/write paths this flag
 * guards are inert, so the command is a harmless no-op rather than a broken
 * affordance.
 */
const pauseMemory = {
  type: 'local',
  name: 'pause-memory',
  aliases: ['memory-pause', 'toggle-memory'],
  description: 'Pause automemory for this session (run again to resume)',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => import('./pauseMemory.js'),
} satisfies Command

export default pauseMemory
