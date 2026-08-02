// Extracted verbatim from src/main.tsx (S7-4b split).
//
// Feature-gated / cycle-breaking module handles used by the root action. These
// stay `require()` rather than `import` for two different reasons, both load
// bearing:
//   - getTeammate* are lazy so the teammate -> AppState -> ... -> main.tsx
//     cycle is not evaluated at module load;
//   - the rest are conditional so a `feature()`-off build can drop them.
// The stray eslint pragma pairs in the original spanned unrelated import lines;
// they are consolidated here into one pair with the same effect.
import { feature } from 'bun:bundle';

/* eslint-disable @typescript-eslint/no-require-imports */
// Lazy require to avoid circular dependency: teammate.ts -> AppState.tsx -> ... -> main.tsx
export const getTeammateUtils = () =>
  require('src/utils/agents/teammate.js') as typeof import('src/utils/agents/teammate.js');
export const getTeammatePromptAddendum = () =>
  require('src/utils/swarm/teammatePromptAddendum.js') as typeof import('src/utils/swarm/teammatePromptAddendum.js');
export const getTeammateModeSnapshot = () =>
  require('src/utils/swarm/backends/teammateModeSnapshot.js') as typeof import('src/utils/swarm/backends/teammateModeSnapshot.js');
// Dead code elimination: conditional import for COORDINATOR_MODE
export const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('src/coordinator/coordinatorMode.js') as typeof import('src/coordinator/coordinatorMode.js'))
  : null;
// Dead code elimination: conditional import for KAIROS (assistant mode)
export const assistantModule = feature('KAIROS')
  ? (require('src/assistant/index.js') as typeof import('src/assistant/index.js'))
  : null;
export const kairosGate = feature('KAIROS')
  ? (require('src/assistant/gate.js') as typeof import('src/assistant/gate.js'))
  : null;

export const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('src/utils/permissions/autoModeState.js') as typeof import('src/utils/permissions/autoModeState.js'))
  : null;
/* eslint-enable @typescript-eslint/no-require-imports */
