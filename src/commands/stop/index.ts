// From types/command.js rather than the commands.js re-export: commands.ts
// imports this descriptor, so taking the type from there closes a cycle that
// check-cycles counts (type edges are included in the `total` ratchet).
import type { Command } from '../../types/command.js'
import { isBgSession } from '../../utils/session/concurrentSessions.js'

/**
 * /stop — end this background session from inside it.
 *
 * The gap it fills: `/exit`, ctrl+c and ctrl+d all *detach* in a bg session
 * (see `commands/exit/exit.tsx`), so before this command the only way to stop
 * one was to detach and run `occ stop <id>` from another terminal. This is the
 * in-session equivalent of that CLI verb — same terminal job state, same
 * "conversation is kept" guarantee.
 *
 * Hidden outside bg sessions rather than erroring inside them: `isBgSession()`
 * already returns false when BG_SESSIONS is compiled out, so no separate
 * feature guard is needed here.
 */
const stop = {
  type: 'local-jsx',
  name: 'stop',
  description: 'Stop this background session, keeping the conversation',
  immediate: true,
  isEnabled: isBgSession,
  load: () => import('./stop.js'),
} satisfies Command

export default stop
