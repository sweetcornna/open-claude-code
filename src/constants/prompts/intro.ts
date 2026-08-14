import type { OutputStyleConfig } from '../outputStyles.js'
import { CYBER_RISK_INSTRUCTION } from '../cyberRiskInstruction.js'

/**
 * The opening block: what this agent is, plus the two standing constraints
 * that have to precede everything else.
 *
 * The product identity line itself does NOT live here — it is prepended by
 * `getCLISyspromptPrefix()` (src/constants/system.ts) so the cache-prefix
 * splitter can identify it by content. See the "must NOT be renamed" list at
 * the top of src/constants/brand.ts before touching that.
 */
export function getIntroSection(
  outputStyleConfig: OutputStyleConfig | null,
): string {
  // eslint-disable-next-line custom-rules/prompt-spacing
  return `
You are an interactive agent that helps users ${outputStyleConfig !== null ? 'according to your "Output Style" below, which describes how you should respond to user queries.' : 'with software engineering tasks.'} Use the instructions below and the tools available to you to assist the user.

${CYBER_RISK_INSTRUCTION}
IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.`
}
