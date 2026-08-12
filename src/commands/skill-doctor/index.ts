import type { Command } from '../../types/command.js'

/**
 * `/skill-doctor` — what the skill listing costs this session, and which of
 * those skills were never invoked.
 *
 * The implementation is loaded on demand (see ./skillDoctor.ts) so registering
 * the command in `src/commands.ts` stays free at startup.
 */
const skillDoctor: Command = {
  type: 'local',
  name: 'skill-doctor',
  description: 'Show which loaded skills are unused and costing context',
  isHidden: false,
  isEnabled: () => true,
  supportsNonInteractive: true,
  bridgeSafe: true,
  load: () => import('./skillDoctor.js'),
}

export default skillDoctor
