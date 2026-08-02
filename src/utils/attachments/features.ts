import { feature } from 'bun:bundle'

// Conditional requires preserve dead-code elimination for optional discovery
// modules while sharing the same live handles across attachment domains.
/* eslint-disable @typescript-eslint/no-require-imports */
// Conditional require for DCE. All skill-search string literals that would
// otherwise leak into external builds live inside these modules. The only
// surfaces in THIS file are: the maybe() call (gated via spread below) and
// the skill_listing suppression check (uses the same skillSearchModules null
// check). The type-only DiscoverySignal import above is erased at compile time.
/* eslint-disable @typescript-eslint/no-require-imports */
export const skillSearchModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      featureCheck:
        require('../../services/skillSearch/featureCheck.js') as typeof import('../../services/skillSearch/featureCheck.js'),
      prefetch:
        require('../../services/skillSearch/prefetch.js') as typeof import('../../services/skillSearch/prefetch.js'),
    }
  : null

export const searchExtraToolsModules = feature(
  'EXPERIMENTAL_SEARCH_EXTRA_TOOLS',
)
  ? {
      prefetch:
        require('../../services/searchExtraTools/prefetch.js') as typeof import('../../services/searchExtraTools/prefetch.js'),
    }
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
