// The Command type comes from types/command.ts, not the commands.ts barrel:
// commands.ts imports this file, and importing it back would add a cycle to
// the check:cycles ratchet (which counts type-only edges too).
import type { Command } from '../../types/command.js'

const searchSetting = {
  type: 'local-jsx',
  name: 'search-setting',
  description: 'Choose which web search sources are used, and connect accounts',
  load: () => import('./search-setting.js'),
} satisfies Command

export default searchSetting
