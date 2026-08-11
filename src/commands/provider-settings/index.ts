// The Command type comes from types/command.ts, not the commands.ts barrel:
// commands.ts imports this file, and importing it back would add a cycle to
// the check:cycles ratchet (which counts type-only edges too).
import type { Command } from '../../types/command.js'

const providerSettings = {
  type: 'local-jsx',
  name: 'provider-settings',
  description:
    'Manage saved provider profiles: switch between them, aggregate their model lists into /model, refresh or delete',
  argumentHint:
    '[list | models | use <name> | save <name> | aggregate <name> on|off | refresh <name> | delete <name>]',
  aliases: ['providers'],
  load: () => import('./provider-settings.js'),
} satisfies Command

export default providerSettings
