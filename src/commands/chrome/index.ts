import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { DISPLAY_NAME } from '../../constants/brand.js'

const command: Command = {
  name: 'chrome',
  description: `Claude in Chrome (Beta) settings for ${DISPLAY_NAME}`,
  availability: [],
  isEnabled: () => !getIsNonInteractiveSession(),
  type: 'local-jsx',
  load: () => import('./chrome.js'),
}

export default command
