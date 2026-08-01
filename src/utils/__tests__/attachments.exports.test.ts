import { describe, expect, test } from 'bun:test'

// Characterization tests for src/utils/attachments.ts.
//
// The export-surface snapshot below is the contract that lets attachments.ts
// be split into leaf modules behind a re-export barrel without touching its
// call sites: if the barrel drops, renames, or adds a symbol, this test fails.
// Regenerate with
//   Object.keys(require('src/utils/attachments.ts')).sort()
// only when a public symbol is deliberately added or removed.
//
// The module is required once at module scope for consistency with the other
// export-surface characterization tests.

const MODULE = require('../attachments.ts') as Record<string, unknown>

const EXPECTED_EXPORTS = [
  'AUTO_MODE_ATTACHMENT_CONFIG',
  'PLAN_MODE_ATTACHMENT_CONFIG',
  'RELEVANT_MEMORIES_CONFIG',
  'TODO_REMINDER_CONFIG',
  'VERIFY_PLAN_REMINDER_CONFIG',
  'collectRecentSuccessfulTools',
  'collectSurfacedMemories',
  'createAttachmentMessage',
  'extractAgentMentions',
  'extractAtMentionedFiles',
  'extractMcpResourceMentions',
  'filterDuplicateMemoryAttachments',
  'filterToBundledAndMcp',
  'generateFileAttachment',
  'getAgentListingDeltaAttachment',
  'getAgentPendingMessageAttachments',
  'getAttachmentMessages',
  'getAttachments',
  'getChangedFiles',
  'getCompactionReminderAttachment',
  'getDateChangeAttachments',
  'getDeferredToolsDeltaAttachment',
  'getDirectoriesToProcess',
  'getMcpInstructionsDeltaAttachment',
  'getQueuedCommandAttachments',
  'getVerifyPlanReminderTurnCount',
  'memoryFilesToAttachments',
  'memoryHeader',
  'parseAtMentionedFileLines',
  'readMemoriesForSurfacing',
  'resetSentSkillNames',
  'startRelevantMemoryPrefetch',
  'suppressNextSkillDiscovery',
  'suppressNextSkillListing',
  'tryGetPDFReference',
]

describe('attachments.ts export surface', () => {
  test('exports exactly the expected named symbols', () => {
    const actual = Object.keys(MODULE).sort()
    expect(actual).toEqual(EXPECTED_EXPORTS)
  })

  // Literal count on purpose: asserting against EXPECTED_EXPORTS.length would
  // be a tautology after the toEqual above, and would still pass if the array
  // itself were bulk-edited.
  test('exports 35 runtime symbols', () => {
    expect(Object.keys(MODULE)).toHaveLength(35)
  })

  test('every exported symbol is defined', () => {
    const undefinedKeys = Object.keys(MODULE).filter(
      k => MODULE[k] === undefined,
    )
    expect(undefinedKeys).toEqual([])
  })
})
