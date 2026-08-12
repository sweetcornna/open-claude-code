/**
 * /cd — move this session to a new working directory.
 *
 * Metadata only; the implementation is lazy-loaded from cd.tsx.
 *
 * Note the difference from /add-dir: /cd REPLACES the session's working
 * directory (process cwd, shell cwd state, originalCwd), while /add-dir only
 * appends a directory to the permission context.
 */
// Typed from types/command.js rather than commands.js (both are valid in this
// repo — see schedule/perf-issue) so the registration import stays one-way and
// no new import cycle is created.
import type { Command } from '../../types/command.js'

const cd = {
  type: 'local-jsx',
  name: 'cd',
  description: 'Move this session to a new working directory',
  argumentHint: '<path>',
  load: () => import('./cd.js'),
} satisfies Command

export default cd
