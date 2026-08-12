import type { SkillListingBudgetOptions } from '@open-claude-code/builtin-tools/tools/SkillTool/constants.js'
import { getSkillUsageScore } from '../suggestions/skillUsageTracking.js'
import { getInitialSettings } from '../settings/settings.js'

/**
 * Assembles everything the skill-listing budget needs from host state:
 *
 * - `skillListingMaxDescChars` (default 1536) — per-skill description cap. A
 *   description longer than this is truncated with an ellipsis before the
 *   listing is even assembled, so it bounds what any single skill can cost.
 * - `skillListingBudgetFraction` (default 0.01) — the share of the context
 *   window, measured in characters (tokens × 4), that the whole listing may
 *   occupy. Exceeding it drops descriptions; it never removes a skill from the
 *   listing, and never affects whether a skill can be invoked.
 * - `usageScore` — the cross-session ranking (frequency × 7-day-half-life
 *   recency) that decides *whose* description survives when the listing is
 *   over budget. Deliberately the global `skillUsage` config rather than
 *   anything session-scoped: a skill you reach for every day should keep its
 *   description in a fresh session too.
 *
 * Kept on the host side because the budget math itself lives in the
 * builtin-tools leaf package and stays a pure function of its arguments.
 * Zod already rejects out-of-range values at load time; the helpers in
 * prompt.ts fall back to the defaults for anything that still slips through
 * (e.g. a policy file merged in with `.passthrough()`).
 */
export function getSkillListingBudgetOptions(): SkillListingBudgetOptions {
  const settings = getInitialSettings()
  return {
    budgetFraction: settings.skillListingBudgetFraction,
    maxDescChars: settings.skillListingMaxDescChars,
    usageScore: getSkillUsageScore,
  }
}
