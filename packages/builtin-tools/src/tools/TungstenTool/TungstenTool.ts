/**
 * Tungsten (virtual terminal) tool — not shipped in this build.
 *
 * `ToolSelector` imports this as a value and reads `isEnabled()`, so the stub
 * has to be an object carrying that method. It previously was not: this file
 * declared `(() => {}) as unknown as Tool`, a *function*, on which
 * `.isEnabled()` would throw. What actually ran was a hand-written
 * `TungstenTool.js` sitting next to it, which did carry `isEnabled`. Whichever
 * of the two the module resolver picked decided whether the app worked, and
 * the TypeScript everyone read was the broken one.
 */
import type { Tool } from '@open-claude-code/tool-runtime/Tool.js'

export const TungstenTool = {
  name: 'TungstenTool',
  isEnabled: () => false,
} as unknown as Tool

export const clearSessionsWithTungstenUsage: () => void = () => {}
export const resetInitializationState: () => void = () => {}
