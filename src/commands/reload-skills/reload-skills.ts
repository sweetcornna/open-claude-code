import type { LocalCommandCall } from '../../types/command.js'
import { isSafeMode, safeModeExitHint } from '../../utils/config/envUtils.js'
import { reloadSkillsWithReport } from '../../utils/skills/skillChangeDetector.js'
import { plural } from '../../utils/text/stringUtils.js'

export const call: LocalCommandCall = async () => {
  const { total, added, removed } = await reloadSkillsWithReport()

  const delta: string[] = []
  if (added > 0) delta.push(`${added} added`)
  if (removed > 0) delta.push(`${removed} removed`)

  const suffix = isSafeMode()
    ? ` (user skills are disabled in safe mode — ${safeModeExitHint()})`
    : ''

  return {
    type: 'text',
    value:
      `Reloaded skills: ${total} ${plural(total, 'skill')} available ` +
      `(${delta.length > 0 ? delta.join(', ') : 'no changes'})${suffix}`,
  }
}
