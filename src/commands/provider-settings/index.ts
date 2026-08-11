// The Command type comes from types/command.ts, not the commands.ts barrel:
// commands.ts imports this file, and importing it back would add a cycle to
// the check:cycles ratchet (which counts type-only edges too).
import type { Command } from '../../types/command.js'

const providerSettings = {
  type: 'local-jsx',
  name: 'provider-settings',
  /**
   * `/provider` (alias `/api`) used to be a second command over the same
   * registry: it ran this implementation for `save|use|list|delete|models|
   * refresh|aggregate` and owned the provider-FAMILY switch on top. Two rows in
   * /help that differed by a suffix, one of them dispatching into the other.
   * Merged; every old name is an alias, so muscle memory and any scripts keep
   * working, and the family switch is now a bare argument here.
   */
  aliases: ['providers', 'provider', 'api'],
  description:
    'Manage providers: add one, switch between saved profiles or provider families, aggregate their model lists into /model, rename, refresh or delete',
  argumentHint:
    '[<family>|unset | list | models | overview | use <name> | save <name> | add [name] | rename <old> <new> | aggregate <name> on|off | refresh <name> | delete <name>]',
  // The argument forms are all text, and `/provider` supported them headlessly
  // before the merge. Bare invocation answers with the listing rather than the
  // panel when there is nothing to render into — see provider-settings.tsx.
  supportsNonInteractive: true,
  load: () => import('./provider-settings.js'),
} satisfies Command

export default providerSettings
