/**
 * Mapping occ's effort ladder onto Gemini's thinking budget.
 *
 * Gemini took no effort parameter at all before this: `/effort` and
 * `CLAUDE_CODE_EFFORT_LEVEL` were accepted, displayed, and then dropped on the
 * floor for the whole provider.
 *
 * Gemini has no effort vocabulary — the one knob it exposes on this route is
 * `generationConfig.thinkingConfig.thinkingBudget`, a token count occ already
 * computes and sends. So the ladder scales that number rather than introducing
 * a field, which is also why this cannot 400 an endpoint that has been working:
 * the request shape is unchanged, only the value moves.
 *
 * `high` is the identity on purpose. It is the factory default for this family
 * (tierDefaults.ts), so a session whose user never touched /effort sends exactly
 * the budget it sent before — the mapping only does something once somebody asks
 * for something.
 *
 *   low 0.25× · medium 0.5× · high 1× · xhigh 1.5× · max 2×
 *
 * The result is clamped to a floor Gemini still treats as "think": 0 switches
 * thinking off entirely on this API, and a rounding-down `low` that silently
 * disabled reasoning would be a very different thing from what the user asked
 * for. The caller applies the output-token ceiling, exactly as the Anthropic
 * path does for its own budget.
 */

/** Below this, Gemini's own docs treat the budget as "off" rather than "small". */
const MIN_THINKING_BUDGET = 128

const EFFORT_SCALE: Record<string, number> = {
  low: 0.25,
  medium: 0.5,
  high: 1,
  xhigh: 1.5,
  max: 2,
}

/**
 * Scale a thinking budget by the requested effort.
 *
 * A budget of -1 (Gemini's "you decide" sentinel) is returned untouched: there
 * is no number there to scale, and turning the sentinel into a concrete budget
 * would take away the dynamic behaviour the caller asked for.
 */
export function applyGeminiEffortToThinkingBudget(
  budgetTokens: number,
  effortValue: unknown,
): number {
  if (budgetTokens < 0) return budgetTokens
  const scale =
    typeof effortValue === 'string' ? EFFORT_SCALE[effortValue] : undefined
  if (scale === undefined || scale === 1) return budgetTokens
  return Math.max(MIN_THINKING_BUDGET, Math.round(budgetTokens * scale))
}
