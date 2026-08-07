import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'model-settings',
  description: 'Set thinking effort and context window per model tier',
  argumentHint:
    '[haiku|sonnet|opus|fable] [effort <level>|context <tokens>|reset]',
  load: () => import('./model-settings.js'),
} satisfies Command
