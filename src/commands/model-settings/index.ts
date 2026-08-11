import type { Command } from '../../commands.js'

const modelSettings = {
  type: 'local-jsx',
  name: 'model-settings',
  // `/models-setting` used to be a separate command that opened the provider
  // wizard's model step. It wrote the same `settings.modelSettings` this one
  // does, so the two read as duplicates whose names differ only in where the
  // `s` sits. Merged; the old name stays as an alias so muscle memory and any
  // scripts keep working.
  aliases: ['models-setting'],
  description:
    'Configure model tiers: which model each of default · haiku · sonnet · opus · fable resolves to, plus its thinking effort and context window',
  argumentHint:
    '[show | <default|haiku|sonnet|opus|fable> effort <level>|context <tokens>|reset]',
  load: () => import('./model-settings.js'),
} satisfies Command

export default modelSettings
