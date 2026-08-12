import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/config/envUtils.js'

const autocompact = {
  type: 'local',
  name: 'autocompact',
  description:
    'Show or set how full the context gets before auto-compaction runs. Usage: /autocompact [auto|500k|200000]',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT),
  supportsNonInteractive: true,
  argumentHint: '[auto|<tokens>]',
  load: () => import('./autocompact.js'),
} satisfies Command

export default autocompact
