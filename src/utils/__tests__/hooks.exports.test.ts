import { describe, expect, test } from 'bun:test'

// Characterization tests for src/utils/hooks.ts.
//
// The export-surface snapshot below is the contract that lets hooks.ts be
// split into leaf modules behind a re-export barrel without touching its call
// sites: if the barrel drops, renames, or adds a symbol, this test fails.
// Regenerate with
//   Object.keys(require('src/utils/hooks.ts')).sort()
// only when a public symbol is deliberately added or removed.
//
// The module is required once at module scope for consistency with the other
// export-surface characterization tests.

const MODULE = require('../hooks.ts') as Record<string, unknown>

const EXPECTED_EXPORTS = [
  'createBaseHookInput',
  'executeConfigChangeHooks',
  'executeCwdChangedHooks',
  'executeElicitationHooks',
  'executeElicitationResultHooks',
  'executeFileChangedHooks',
  'executeFileSuggestionCommand',
  'executeInstructionsLoadedHooks',
  'executeNotificationHooks',
  'executePermissionDeniedHooks',
  'executePermissionRequestHooks',
  'executePostCompactHooks',
  'executePostToolHooks',
  'executePostToolUseFailureHooks',
  'executePreCompactHooks',
  'executePreToolHooks',
  'executeSessionEndHooks',
  'executeSessionStartHooks',
  'executeSetupHooks',
  'executeStatusLineCommand',
  'executeStopFailureHooks',
  'executeStopHooks',
  'executeSubagentStartHooks',
  'executeTaskCompletedHooks',
  'executeTaskCreatedHooks',
  'executeTeammateIdleHooks',
  'executeUserPromptSubmitHooks',
  'executeWorktreeCreateHook',
  'executeWorktreeRemoveHook',
  'getMatchingHooks',
  'getPreToolHookBlockingMessage',
  'getSessionEndHookTimeoutMs',
  'getStopHookMessage',
  'getTaskCompletedHookMessage',
  'getTaskCreatedHookMessage',
  'getTeammateIdleHookMessage',
  'getUserPromptSubmitHookBlockingMessage',
  'hasBlockingResult',
  'hasInstructionsLoadedHook',
  'hasWorktreeCreateHook',
  'shouldSkipHookDueToTrust',
]

describe('hooks.ts export surface', () => {
  test('exports exactly the expected named symbols', () => {
    const actual = Object.keys(MODULE).sort()
    expect(actual).toEqual(EXPECTED_EXPORTS)
  })

  // Literal count on purpose: asserting against EXPECTED_EXPORTS.length would
  // be a tautology after the toEqual above, and would still pass if the array
  // itself were bulk-edited.
  test('exports 41 runtime symbols', () => {
    expect(Object.keys(MODULE)).toHaveLength(41)
  })

  test('every exported symbol is defined', () => {
    const undefinedKeys = Object.keys(MODULE).filter(
      k => MODULE[k] === undefined,
    )
    expect(undefinedKeys).toEqual([])
  })
})
