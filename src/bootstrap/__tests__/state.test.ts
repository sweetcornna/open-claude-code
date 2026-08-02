import { beforeEach, describe, expect, test } from 'bun:test'
import {
  addSlowOperation,
  getModelUsage,
  getOriginalCwd,
  getParentSessionId,
  getPlanSlugCache,
  getSessionId,
  getSessionProjectDir,
  getSlowOperations,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalToolDuration,
  getTotalWebSearchRequests,
  getUsageForModel,
  onSessionSwitch,
  regenerateSessionId,
  resetStateForTests,
  setCostStateForRestore,
  setPlanSlugCacheEntry,
  switchSession,
} from '../state.js'
import type { SessionId } from '../../types/ids.js'

// Characterization tests for src/bootstrap/state.ts.
//
// The export-surface snapshot below is the contract that lets state.ts be
// split into leaf modules behind a re-export barrel without touching any of
// the ~285 call sites: if the barrel drops, renames, or adds a symbol, this
// test fails. Regenerate with
//   Object.keys(require('src/bootstrap/state.ts')).sort()
// only when a public accessor is deliberately added or removed.
//
// No mock.module here on purpose: state.ts only imports pure leaves
// (crypto, signal, brand constants, settingsCache), so it loads as-is.

const EXPECTED_EXPORTS = [
  'addInvokedSkill',
  'addSessionCronTask',
  'addSlowOperation',
  'addToInMemoryErrorLog',
  'addToToolDuration',
  'addToTotalCostState',
  'addToTotalDurationState',
  'addToTotalLinesChanged',
  'addToTurnClassifierDuration',
  'addToTurnHookDuration',
  'clearBetaHeaderLatches',
  'clearInvokedSkills',
  'clearInvokedSkillsForAgent',
  'clearRegisteredPluginHooks',
  'clearSystemPromptSectionState',
  'consumePostCompaction',
  'flushInteractionTime',
  'getActiveTimeCounter',
  'getAdditionalDirectoriesForClaudeMd',
  'getAfkModeHeaderLatched',
  'getAgentColorMap',
  'getAllowedChannels',
  'getAllowedSettingSources',
  'getApiKeyFromFd',
  'getBudgetContinuationCount',
  'getCacheEditingHeaderLatched',
  'getCachedClaudeMdContent',
  'getChromeFlagOverride',
  'getClientType',
  'getCodeEditToolDecisionCounter',
  'getCommitCounter',
  'getCostCounter',
  'getCurrentTurnTokenBudget',
  'getCwdState',
  'getEventLogger',
  'getFastModeHeaderLatched',
  'getFlagSettingsInline',
  'getFlagSettingsPath',
  'getHasDevChannels',
  'getInitJsonSchema',
  'getInitialMainLoopModel',
  'getInlinePlugins',
  'getInvokedSkillsForAgent',
  'getIsInteractive',
  'getIsNonInteractiveSession',
  'getIsRemoteMode',
  'getIsScrollDraining',
  'getKairosActive',
  'getLastAPIRequest',
  'getLastApiCompletionTimestamp',
  'getLastEmittedDate',
  'getLastInteractionTime',
  'getLastMainRequestId',
  'getLocCounter',
  'getLoggerProvider',
  'getMainLoopModelOverride',
  'getMainThreadAgentType',
  'getMeter',
  'getMeterProvider',
  'getModelStrings',
  'getModelUsage',
  'getOauthTokenFromFd',
  'getOriginalCwd',
  'getParentSessionId',
  'getPlanSlugCache',
  'getPrCounter',
  'getProjectRoot',
  'getPromptCache1hAllowlist',
  'getPromptCache1hEligible',
  'getPromptId',
  'getQuestionPreviewFormat',
  'getRegisteredHooks',
  'getRemoteServerUrl',
  'getScheduledTasksEnabled',
  'getSdkAgentProgressSummariesEnabled',
  'getSdkBetas',
  'getSessionBypassPermissionsMode',
  'getSessionCounter',
  'getSessionCreatedTeams',
  'getSessionCronTasks',
  'getSessionId',
  'getSessionIngressToken',
  'getSessionProjectDir',
  'getSessionTrustAccepted',
  'getSlowOperations',
  'getStatsStore',
  'getStrictToolResultPairing',
  'getSystemPromptSectionCache',
  'getTeleportedSessionInfo',
  'getTokenCounter',
  'getTotalAPIDuration',
  'getTotalAPIDurationWithoutRetries',
  'getTotalCacheCreationInputTokens',
  'getTotalCacheReadInputTokens',
  'getTotalCostUSD',
  'getTotalDuration',
  'getTotalInputTokens',
  'getTotalLinesAdded',
  'getTotalLinesRemoved',
  'getTotalOutputTokens',
  'getTotalToolDuration',
  'getTotalWebSearchRequests',
  'getTracerProvider',
  'getTurnClassifierCount',
  'getTurnClassifierDurationMs',
  'getTurnHookCount',
  'getTurnHookDurationMs',
  'getTurnOutputTokens',
  'getTurnToolCount',
  'getTurnToolDurationMs',
  'getUsageForModel',
  'getUseCoworkPlugins',
  'getUserMsgOptIn',
  'handleAutoModeTransition',
  'handlePlanModeTransition',
  'hasExitedPlanModeInSession',
  'hasShownLspRecommendationThisSession',
  'hasUnknownModelCost',
  'incrementBudgetContinuationCount',
  'isSessionPersistenceDisabled',
  'markFirstTeleportMessageLogged',
  'markPostCompaction',
  'needsAutoModeExitAttachment',
  'needsPlanModeExitAttachment',
  'onSessionSwitch',
  'preferThirdPartyAuthentication',
  'regenerateSessionId',
  'registerHookCallbacks',
  'removeSessionCronTasks',
  'resetCostState',
  'resetModelStringsForTestingOnly',
  'resetSdkInitState',
  'resetStateForTests',
  'resetTotalDurationStateAndCost_FOR_TESTS_ONLY',
  'resetTurnClassifierDuration',
  'resetTurnHookDuration',
  'resetTurnToolDuration',
  'setAdditionalDirectoriesForClaudeMd',
  'setAfkModeHeaderLatched',
  'setAllowedChannels',
  'setAllowedSettingSources',
  'setApiKeyFromFd',
  'setCacheEditingHeaderLatched',
  'setCachedClaudeMdContent',
  'setChromeFlagOverride',
  'setClientType',
  'setCostStateForRestore',
  'setCwdState',
  'setEventLogger',
  'setFastModeHeaderLatched',
  'setFlagSettingsInline',
  'setFlagSettingsPath',
  'setHasDevChannels',
  'setHasExitedPlanMode',
  'setHasUnknownModelCost',
  'setInitJsonSchema',
  'setInitialMainLoopModel',
  'setInlinePlugins',
  'setIsInteractive',
  'setIsRemoteMode',
  'setKairosActive',
  'setLastAPIRequest',
  'setLastApiCompletionTimestamp',
  'setLastEmittedDate',
  'setLastMainRequestId',
  'setLoggerProvider',
  'setLspRecommendationShownThisSession',
  'setMainLoopModelOverride',
  'setMainThreadAgentType',
  'setMeter',
  'setMeterProvider',
  'setModelStrings',
  'setNeedsAutoModeExitAttachment',
  'setNeedsPlanModeExitAttachment',
  'setOauthTokenFromFd',
  'setOriginalCwd',
  'setPlanSlugCacheEntry',
  'setProjectRoot',
  'setPromptCache1hAllowlist',
  'setPromptCache1hEligible',
  'setPromptId',
  'setQuestionPreviewFormat',
  'setRemoteServerUrl',
  'setScheduledTasksEnabled',
  'setSdkAgentProgressSummariesEnabled',
  'setSdkBetas',
  'setSessionBypassPermissionsMode',
  'setSessionIngressToken',
  'setSessionPersistenceDisabled',
  'setSessionSource',
  'setSessionTrustAccepted',
  'setStatsStore',
  'setStrictToolResultPairing',
  'setSystemPromptSectionCacheEntry',
  'setTeleportedSessionInfo',
  'setTracerProvider',
  'setUseCoworkPlugins',
  'setUserMsgOptIn',
  'snapshotOutputTokensForTurn',
  'switchSession',
  'updateLastInteractionTime',
  'waitForScrollIdle',
]

describe('state.ts export surface', () => {
  test('exports exactly the expected named symbols', () => {
    const actual = Object.keys(
      require('../state.ts') as Record<string, unknown>,
    ).sort()
    expect(actual).toEqual(EXPECTED_EXPORTS)
  })

  test('exports 207 runtime symbols', () => {
    const actual = Object.keys(
      require('../state.ts') as Record<string, unknown>,
    )
    expect(actual).toHaveLength(EXPECTED_EXPORTS.length)
  })

  test('every exported symbol is defined', () => {
    const mod = require('../state.ts') as Record<string, unknown>
    const undefinedKeys = Object.keys(mod).filter(k => mod[k] === undefined)
    expect(undefinedKeys).toEqual([])
  })
})

describe('regenerateSessionId', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  test('replaces the session id with a fresh uuid', () => {
    const before = getSessionId()
    const after = regenerateSessionId()
    expect(after).not.toBe(before)
    expect(getSessionId()).toBe(after)
  })

  test('leaves parentSessionId untouched by default', () => {
    expect(getParentSessionId()).toBeUndefined()
    regenerateSessionId()
    expect(getParentSessionId()).toBeUndefined()
  })

  test('promotes the outgoing id to parent when setCurrentAsParent is set', () => {
    const before = getSessionId()
    regenerateSessionId({ setCurrentAsParent: true })
    expect(getParentSessionId()).toBe(before)
    expect(getSessionId()).not.toBe(before)
  })

  test('drops the outgoing session plan-slug entry', () => {
    const before = getSessionId()
    setPlanSlugCacheEntry(before, 'brave-otter')
    expect(getPlanSlugCache().get(before)).toBe('brave-otter')
    regenerateSessionId()
    expect(getPlanSlugCache().has(before)).toBe(false)
  })

  test('resets the session project dir so paths derive from originalCwd', () => {
    switchSession('sid-elsewhere' as SessionId, '/somewhere/else')
    expect(getSessionProjectDir()).toBe('/somewhere/else')
    regenerateSessionId()
    expect(getSessionProjectDir()).toBeNull()
  })
})

describe('switchSession', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  test('sets sessionId and sessionProjectDir together', () => {
    switchSession('sid-a' as SessionId, '/projects/a')
    expect(getSessionId()).toBe('sid-a' as SessionId)
    expect(getSessionProjectDir()).toBe('/projects/a')
  })

  test('resets the project dir when none is passed', () => {
    switchSession('sid-a' as SessionId, '/projects/a')
    switchSession('sid-b' as SessionId)
    expect(getSessionProjectDir()).toBeNull()
  })

  test('emits to subscribers registered via onSessionSwitch', () => {
    const seen: string[] = []
    const unsubscribe = onSessionSwitch(id => {
      seen.push(id)
    })
    switchSession('sid-1' as SessionId)
    switchSession('sid-2' as SessionId, '/p')
    unsubscribe()
    expect(seen).toEqual(['sid-1', 'sid-2'])
  })

  test('stops emitting after unsubscribe', () => {
    let calls = 0
    const unsubscribe = onSessionSwitch(() => {
      calls++
    })
    switchSession('sid-1' as SessionId)
    unsubscribe()
    switchSession('sid-2' as SessionId)
    expect(calls).toBe(1)
  })

  test('fans out to every registered subscriber', () => {
    const seen: string[] = []
    const un1 = onSessionSwitch(() => {
      seen.push('a')
    })
    const un2 = onSessionSwitch(() => {
      seen.push('b')
    })
    switchSession('sid-1' as SessionId)
    un1()
    un2()
    expect(seen).toEqual(['a', 'b'])
  })

  test('drops the outgoing session plan-slug entry', () => {
    const before = getSessionId()
    setPlanSlugCacheEntry(before, 'calm-heron')
    switchSession('sid-next' as SessionId)
    expect(getPlanSlugCache().has(before)).toBe(false)
  })

  test('resetStateForTests clears session-switch subscribers', () => {
    let calls = 0
    onSessionSwitch(() => {
      calls++
    })
    resetStateForTests()
    switchSession('sid-after-reset' as SessionId)
    expect(calls).toBe(0)
  })
})

describe('setCostStateForRestore', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  test('round-trips every restored scalar through its getter', () => {
    setCostStateForRestore({
      totalCostUSD: 1.25,
      totalAPIDuration: 4200,
      totalAPIDurationWithoutRetries: 3100,
      totalToolDuration: 900,
      totalLinesAdded: 42,
      totalLinesRemoved: 7,
      lastDuration: undefined,
      modelUsage: undefined,
    })
    expect(getTotalCostUSD()).toBe(1.25)
    expect(getTotalAPIDuration()).toBe(4200)
    expect(getTotalAPIDurationWithoutRetries()).toBe(3100)
    expect(getTotalToolDuration()).toBe(900)
    expect(getTotalLinesAdded()).toBe(42)
    expect(getTotalLinesRemoved()).toBe(7)
  })

  test('restores the per-model usage breakdown and derived token totals', () => {
    setCostStateForRestore({
      totalCostUSD: 0,
      totalAPIDuration: 0,
      totalAPIDurationWithoutRetries: 0,
      totalToolDuration: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      lastDuration: undefined,
      modelUsage: {
        'model-a': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 40,
          webSearchRequests: 1,
          costUSD: 0,
          contextWindow: 200000,
          maxOutputTokens: 64000,
        },
        'model-b': {
          inputTokens: 5,
          outputTokens: 6,
          cacheReadInputTokens: 7,
          cacheCreationInputTokens: 8,
          webSearchRequests: 2,
          costUSD: 0,
          contextWindow: 200000,
          maxOutputTokens: 64000,
        },
      },
    })
    expect(Object.keys(getModelUsage()).sort()).toEqual(['model-a', 'model-b'])
    expect(getUsageForModel('model-a')?.inputTokens).toBe(10)
    expect(getUsageForModel('missing')).toBeUndefined()
    expect(getTotalInputTokens()).toBe(15)
    expect(getTotalOutputTokens()).toBe(26)
    expect(getTotalCacheReadInputTokens()).toBe(37)
    expect(getTotalCacheCreationInputTokens()).toBe(48)
    expect(getTotalWebSearchRequests()).toBe(3)
  })

  test('leaves modelUsage untouched when none is supplied', () => {
    setCostStateForRestore({
      totalCostUSD: 0,
      totalAPIDuration: 0,
      totalAPIDurationWithoutRetries: 0,
      totalToolDuration: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      lastDuration: undefined,
      modelUsage: undefined,
    })
    expect(getModelUsage()).toEqual({})
  })

  test('rewinds startTime so wall duration keeps accumulating', () => {
    setCostStateForRestore({
      totalCostUSD: 0,
      totalAPIDuration: 0,
      totalAPIDurationWithoutRetries: 0,
      totalToolDuration: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      lastDuration: 60_000,
      modelUsage: undefined,
    })
    expect(getTotalDuration()).toBeGreaterThanOrEqual(60_000)
  })
})

describe('getSlowOperations', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  test('returns a stable reference while empty', () => {
    expect(getSlowOperations()).toHaveLength(0)
    expect(getSlowOperations()).toBe(getSlowOperations())
  })

  test('keeps the same empty reference across a reset', () => {
    const before = getSlowOperations()
    resetStateForTests()
    expect(getSlowOperations()).toBe(before)
  })

  test('is a no-op for non-ant users', () => {
    const previous = process.env.USER_TYPE
    delete process.env.USER_TYPE
    try {
      addSlowOperation('op', 1234)
      expect(getSlowOperations()).toHaveLength(0)
    } finally {
      if (previous === undefined) {
        delete process.env.USER_TYPE
      } else {
        process.env.USER_TYPE = previous
      }
    }
  })
})

describe('getOriginalCwd', () => {
  test('is a non-empty absolute-ish path at module init', () => {
    expect(typeof getOriginalCwd()).toBe('string')
    expect(getOriginalCwd().length).toBeGreaterThan(0)
  })
})
