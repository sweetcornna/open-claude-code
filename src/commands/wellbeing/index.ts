import type { Command } from '../../commands.js'

const command = {
  type: 'local',
  name: 'wellbeing',
  aliases: ['breaks', 'break-reminder', 'downtime'],
  description: 'Configure optional break reminders and quiet-hours nudges',
  argumentHint: '[on|off|interval <min>|break <min>|quiet <HH:MM-HH:MM>|off]',
  supportsNonInteractive: true,
  load: () => import('./wellbeing.js'),
} satisfies Command

export default command
