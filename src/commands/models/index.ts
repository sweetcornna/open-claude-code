import type { Command } from '../../commands.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'models-setting',
    description:
      'Edit the current provider’s models without redoing login: default model, per-tier mapping (haiku · sonnet · opus · fable), max context tokens and thinking effort',
    load: () => import('./models.js'),
  }) satisfies Command
