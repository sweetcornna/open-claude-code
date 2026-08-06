import type { Command } from '../../commands.js'
import { currentProviderSetupKind } from '../../components/providerSetup/fromEnvironment.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'models',
    description:
      'Choose which model each tier (haiku · sonnet · opus · fable) resolves to',
    // Hidden for sessions with nothing to point anywhere — a first-party login
    // resolves its tiers through the built-in Claude table.
    isEnabled: () => currentProviderSetupKind() !== undefined,
    load: () => import('./models.js'),
  }) satisfies Command
