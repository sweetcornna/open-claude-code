import { describe, expect, test } from 'bun:test'

// Characterization tests for src/utils/sessionStorage.ts.
//
// The export-surface snapshot below is the contract that lets sessionStorage.ts
// be split into leaf modules behind a re-export barrel without touching its
// call sites: if the barrel drops, renames, or adds a symbol, this test fails.
// Regenerate with
//   Object.keys(require('src/utils/sessionStorage.ts')).sort()
// only when a public symbol is deliberately added or removed.
//
// Keep the require at module scope because initial module evaluation can exceed
// bun:test's per-test timeout.

const MODULE = require('../sessionStorage.ts') as Record<string, unknown>

const EXPECTED_EXPORTS = [
  'MAX_TRANSCRIPT_READ_BYTES',
  'adoptResumedSessionFile',
  'buildConversationChain',
  'cacheSessionTitle',
  'checkResumeConsistency',
  'cleanMessagesForLogging',
  'clearAgentTranscriptSubdir',
  'clearGoalEntry',
  'clearSessionMessagesCache',
  'clearSessionMetadata',
  'deleteRemoteAgentMetadata',
  'doesMessageExistInSession',
  'enrichLogs',
  'extractAgentIdsFromMessages',
  'extractTeammateTranscriptsFromTasks',
  'fetchLogs',
  'findUnresolvedToolUse',
  'flushSessionStorage',
  'getAgentTranscript',
  'getAgentTranscriptPath',
  'getCurrentSessionAgentColor',
  'getCurrentSessionTag',
  'getCurrentSessionTitle',
  'getFirstMeaningfulUserMessageTextContent',
  'getLastSessionLog',
  'getLogByIndex',
  'getNodeEnv',
  'getProjectDir',
  'getProjectsDir',
  'getSessionFilesLite',
  'getSessionFilesWithMtime',
  'getSessionIdFromLog',
  'getSessionMessages',
  'getSessionMessagesCache',
  'getTranscriptPath',
  'getTranscriptPathForSession',
  'getUserType',
  'hydrateFromCCRv2InternalEvents',
  'hydrateRemoteSession',
  'isChainParticipant',
  'isCustomTitleEnabled',
  'isEphemeralToolProgress',
  'isLiteLog',
  'isLoggableMessage',
  'isTranscriptMessage',
  'linkSessionToPR',
  'listRemoteAgentMetadata',
  'loadAllLogsFromSessionFile',
  'loadAllProjectsMessageLogs',
  'loadAllProjectsMessageLogsProgressive',
  'loadAllSubagentTranscriptsFromDisk',
  'loadFullLog',
  'loadMessageLogs',
  'loadSameRepoMessageLogs',
  'loadSameRepoMessageLogsProgressive',
  'loadSubagentTranscripts',
  'loadTranscriptFile',
  'loadTranscriptFromFile',
  'reAppendSessionMetadata',
  'readAgentMetadata',
  'readRemoteAgentMetadata',
  'recordAttributionSnapshot',
  'recordContentReplacement',
  'recordFileHistorySnapshot',
  'recordQueueOperation',
  'recordSidechainTranscript',
  'recordTranscript',
  'removeExtraFields',
  'removeTranscriptMessage',
  'resetProjectFlushStateForTesting',
  'resetProjectForTesting',
  'resetSessionFilePointer',
  'restoreSessionMetadata',
  'saveAgentColor',
  'saveAgentName',
  'saveAgentSetting',
  'saveAiGeneratedTitle',
  'saveCustomTitle',
  'saveGoal',
  'saveMode',
  'saveTag',
  'saveTaskSummary',
  'saveWorktreeState',
  'searchSessionsByCustomTitle',
  'sessionIdExists',
  'setAgentTranscriptSubdir',
  'setInternalEventReader',
  'setInternalEventWriter',
  'setRemoteIngressUrlForTesting',
  'setSessionFileForTesting',
  'writeAgentMetadata',
  'writeRemoteAgentMetadata',
]

describe('sessionStorage.ts export surface', () => {
  test('exports exactly the expected named symbols', () => {
    const actual = Object.keys(MODULE).sort()
    expect(actual).toEqual(EXPECTED_EXPORTS)
  })

  // Literal count on purpose: asserting against EXPECTED_EXPORTS.length would
  // be a tautology after the toEqual above, and would still pass if the array
  // itself were bulk-edited.
  test('exports 92 runtime symbols', () => {
    expect(Object.keys(MODULE)).toHaveLength(92)
  })

  test('every exported symbol is defined', () => {
    const undefinedKeys = Object.keys(MODULE).filter(
      k => MODULE[k] === undefined,
    )
    expect(undefinedKeys).toEqual([])
  })
})
