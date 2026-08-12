import { buildSkillListing } from '@open-claude-code/builtin-tools/tools/SkillTool/prompt.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import type {
  LocalCommandCall,
  LocalCommandResult,
} from '../../types/command.js'
import { collectListingSkillCommands } from '../../utils/attachments/skills.js'
import { getContextWindowForModel } from '../../utils/session/context.js'
import { getSkillListingBudgetOptions } from '../../utils/skills/listingBudget.js'
import {
  buildSkillDoctorReport,
  countSkillInvocations,
  type SkillListingCost,
} from './report.js'

/**
 * Lazily imported by ./index.ts. Kept out of the command descriptor because
 * this module reaches back into `src/commands.ts` (via the attachment helper
 * that collects the listing), and `commands.ts` is imported at startup — a
 * static edge would close that cycle at import time.
 */
export const call: LocalCommandCall = async (
  _args,
  context,
): Promise<LocalCommandResult> => {
  // Same skill set and same budget the skill_listing attachment uses, so the
  // costs reported here are the costs the model is actually paying.
  const commands = await collectListingSkillCommands(context)
  const contextWindowTokens = getContextWindowForModel(
    context.options.mainLoopModel,
    getSdkBetas(),
    context.options.modelSettingsSlot,
  )
  const listing = buildSkillListing(
    commands,
    contextWindowTokens,
    getSkillListingBudgetOptions(),
  )

  const costs: SkillListingCost[] = listing.entries.map(entry => ({
    name: entry.command.name,
    source:
      entry.command.loadedFrom ??
      (entry.command.type === 'prompt' ? entry.command.source : 'unknown'),
    chars: entry.chars,
    degraded: entry.degraded,
  }))

  return {
    type: 'text',
    value: buildSkillDoctorReport(
      costs,
      countSkillInvocations(context.messages),
      {
        budget: listing.budget,
        totalChars: listing.totalChars,
        fullTotal: listing.fullTotal,
        overBudget: listing.overBudget,
        contextWindowTokens,
      },
    ),
  }
}
