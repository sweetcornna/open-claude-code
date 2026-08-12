export const SKILL_TOOL_NAME = 'Skill'

// Skill listing budget vocabulary. It lives here rather than in prompt.ts
// because prompt.ts pulls in `src/commands.ts` (and with it most of the host):
// consumers that only need the units — the settings reader, /skill-doctor's
// report — would drag that whole graph in behind a single number. prompt.ts
// re-exports these, so the public surface is unchanged.

/** Chars-per-token the listing budget is denominated in. */
export const CHARS_PER_TOKEN = 4

/** Skill listing gets 1% of the context window (in characters) by default. */
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01

/**
 * Fallback window when the caller has no resolved context size. With a
 * user-settable fraction the fallback budget has to be recomputed from this
 * rather than hardcoded.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000

/**
 * Per-entry hard cap. The listing is for discovery only — the Skill tool loads
 * full content on invoke, so verbose whenToUse strings waste turn-1
 * cache_creation tokens without improving match rate. Applies to all entries,
 * including bundled, since the cap is generous enough to preserve the core use
 * case. v2.1.117: raised from 250 → 1536 to allow richer skill descriptions.
 */
export const MAX_LISTING_DESC_CHARS = 1536

/**
 * User-tunable knobs for the skill listing budget, backing the
 * `skillListingBudgetFraction` / `skillListingMaxDescChars` settings.
 *
 * Deliberately passed into the budget math rather than read from settings
 * there: that math lives in the builtin-tools leaf package, and threading the
 * values through keeps it a pure function (unit-testable with no settings
 * mock). The host reads the settings in `src/utils/skills/listingBudget.ts`
 * and hands them to the callers that render or audit the listing.
 *
 * Both fields fall back to the defaults above when omitted or out of range, so
 * a hand-edited settings file can never produce a nonsensical budget.
 */
export type SkillListingBudgetOptions = {
  /** `skillListingBudgetFraction` — fraction of the context window (0 < f <= 1). */
  budgetFraction?: number
  /** `skillListingMaxDescChars` — per-skill description cap, in characters. */
  maxDescChars?: number
  /**
   * Cross-session usage score for a skill, used to rank which descriptions
   * survive when the listing is over budget. Higher wins.
   *
   * Injected rather than imported so the budget math stays pure: the real
   * implementation (`getSkillUsageScore`) reads the global config, which this
   * leaf package must not reach into. Omitting it scores everything 0, which
   * degrades in stable listing order — correct, just not usage-aware.
   *
   * Keyed by skill name (not the Command) so this module keeps zero imports.
   */
  usageScore?: (skillName: string) => number
}
