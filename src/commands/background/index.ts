import type { Command } from '../../commands.js'

/**
 * Deliberately thin. `src/commands.ts` imports every descriptor statically, so
 * anything pulled in here is paid for on every interactive start — the job
 * store, the bg engines and the handoff planner all live behind `load()`.
 *
 * Not `immediate`. Official's `/bg` runs mid-turn and re-drives the
 * interrupted round in the child with `--reply-on-resume`; occ has no such
 * flag, so backgrounding mid-turn would drop the in-flight round on the floor.
 * Queuing to the next stop point costs the user the tail of one turn and
 * loses nothing. Ctrl+B (`useSessionBackgrounding`) remains the way to push
 * the *current* round into the background.
 */
const background = {
  type: 'local-jsx',
  name: 'background',
  aliases: ['bg'],
  description: 'Send this session to the background and free the terminal',
  argumentHint: '[prompt]',
  load: () => import('./background.js'),
} satisfies Command

export default background
