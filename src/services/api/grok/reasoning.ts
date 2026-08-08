/**
 * Mapping occ's effort ladder onto xAI's.
 *
 * Grok took no effort parameter at all before this: `/effort` and
 * `CLAUDE_CODE_EFFORT_LEVEL` were accepted, displayed, and then dropped on the
 * floor for the whole provider.
 *
 * Two things make this narrower than the other providers':
 *
 *   - xAI's ladder is TWO rungs, `low` and `high`. occ's five collapse onto
 *     them the same way DeepSeek's three do (see resolveDeepSeekReasoningEffort)
 *     — the middle of the ladder rounds up, because a coding agent asking for
 *     "medium" wants reasoning, not the cheap rung.
 *   - Only the `grok-3-mini` family accepts the field. The grok-4 reasoning
 *     models always reason and REJECT `reasoning_effort` outright, so sending it
 *     there would turn a preference into a 400 for every request in the session.
 *     Returning undefined for them is not a gap; it is the parameter not
 *     existing on that model.
 */

/** Models that take `reasoning_effort`. */
function acceptsReasoningEffort(model: string): boolean {
  return model.toLowerCase().includes('grok-3-mini')
}

type GrokReasoningEffort = 'low' | 'high'

/**
 * The rung to send, or undefined to send nothing (no effort chosen, or a model
 * that does not take the parameter).
 */
export function resolveGrokReasoningEffort(
  model: string,
  effortValue: unknown,
): GrokReasoningEffort | undefined {
  if (!acceptsReasoningEffort(model)) return undefined
  switch (effortValue) {
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high'
    default:
      // Unset, and the ant-only numeric efforts that have no rung here: leave
      // the parameter off and inherit xAI's own default.
      return undefined
  }
}
