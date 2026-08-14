import type { OutputStyleConfig } from '../outputStyles.js'

/**
 * The orthography sentence is not padding: without it models routinely strip
 * diacritics when the surrounding conversation is ASCII, which reads as broken
 * text to anyone who set a non-English language.
 */
export function getLanguageSection(
  languagePreference: string | undefined,
): string | null {
  if (!languagePreference) return null

  return `# Language
Always respond in ${languagePreference}. Use ${languagePreference} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.
Maintain full orthographic correctness for ${languagePreference}, including all required diacritical marks, accents, and special characters. Never substitute accented characters with their ASCII equivalents (e.g., never write "nao" for "não", "fur" for "für", or "loeschen" for "löschen").`
}

export function getOutputStyleSection(
  outputStyleConfig: OutputStyleConfig | null,
): string | null {
  if (outputStyleConfig === null) return null

  return `# Output Style: ${outputStyleConfig.name}
${outputStyleConfig.prompt}`
}
