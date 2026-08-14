// From types/command.js rather than the commands.js re-export: commands.ts
// imports this descriptor, so taking the type from there closes a cycle that
// check-cycles counts (type edges are included in the `total` ratchet).
import type { Command } from '../../types/command.js'

/**
 * /reload-skills — re-read the skill directories mid-session.
 *
 * occ already watches those directories (`utils/skills/skillChangeDetector`),
 * so this is the escape hatch rather than the main path: the watcher polls
 * under Bun (see the deadlock note in that file), debounces, and is not started
 * at all in `--bare` mode. This command is the deterministic "I edited a skill,
 * pick it up now" answer, and it reports what actually changed so a no-op is
 * distinguishable from a reload that found nothing.
 *
 * Plugin-provided skills are NOT in scope — those are /reload-plugins.
 */
const reloadSkills = {
  type: 'local',
  name: 'reload-skills',
  description: 'Pick up skills added or changed on disk during this session',
  supportsNonInteractive: true,
  load: () => import('./reload-skills.js'),
} satisfies Command

export default reloadSkills
