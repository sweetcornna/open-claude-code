import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UUID } from 'node:crypto'
import type { Message } from '../../types/message.js'

// Characterization test for the write→read round trip through the session
// JSONL file: recordTranscript() → flushSessionStorage() → loadTranscriptFile().
//
// sessionStorage.ts is about to be split into leaf modules. The export-surface
// snapshot in sessionStorage.exports.test.ts pins the *names*; this pins the
// one behavior that spans the whole module — that the writer and the reader
// agree on the on-disk format. A split that moves the stamping code
// (sessionId/cwd/version/parentUuid) away from the entry-parsing code without
// keeping them in sync fails here rather than silently producing transcripts
// that --resume cannot rebuild.
//
// No mock.module: sessionStorage.ts loads cleanly on its own, and Bun's
// mock.module is process-global (last-write-wins across the whole test
// process), so mocking anything here would leak into every other test file.
// Isolation comes from CLAUDE_CONFIG_DIR + setSessionFileForTesting instead.

const {
  clearSessionMessagesCache,
  flushSessionStorage,
  loadTranscriptFile,
  recordTranscript,
  resetProjectForTesting,
  setSessionFileForTesting,
  buildConversationChain,
} = await import('../sessionStorage.js')

const { getSessionId } = await import('../../bootstrap/state.js')

let tempDir: string
let sessionFile: string
let originalConfigDir: string | undefined
let originalTestPersistence: string | undefined

/**
 * Build a minimal transcript-shaped message. The persisted Entry union only
 * cares about `type` + `uuid` + `message`; everything else (sessionId, cwd,
 * version, timestamp, parentUuid) is stamped by insertMessageChain on write,
 * which is exactly what this test is checking.
 */
function userMessage(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid: uuid as UUID,
    message: { role: 'user', content: text },
  } as unknown as Message
}

function assistantMessage(uuid: string, text: string): Message {
  return {
    type: 'assistant',
    uuid: uuid as UUID,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  } as unknown as Message
}

beforeEach(() => {
  // Pin every path sessionStorage derives (getProjectsDir, loadSessionFile)
  // to a throwaway dir so the developer's real ~/.occ/projects is untouched.
  tempDir = mkdtempSync(join(tmpdir(), 'occ-session-roundtrip-'))
  mkdirSync(join(tempDir, 'projects'), { recursive: true })
  sessionFile = join(tempDir, 'projects', 'roundtrip.jsonl')

  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir

  // Project.shouldSkipPersistence() short-circuits every write when
  // NODE_ENV === 'test' unless this opt-in is set. Without it the round trip
  // would silently assert against an empty file.
  originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

  // Drop any Project instance a previously-run test file left behind (it
  // would carry a stale sessionFile path), then point the fresh one at the
  // temp file. Order matters: setSessionFileForTesting lazily constructs the
  // singleton, so the reset has to come first.
  resetProjectForTesting()
  setSessionFileForTesting(sessionFile)
  clearSessionMessagesCache()
})

afterEach(async () => {
  await flushSessionStorage()
  clearSessionMessagesCache()
  resetProjectForTesting()

  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (originalTestPersistence === undefined) {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  } else {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
  }

  rmSync(tempDir, { recursive: true, force: true })
})

afterAll(() => {
  // Leave no Project singleton pointing at a deleted temp path for whichever
  // test file bun runs next in this process.
  resetProjectForTesting()
  clearSessionMessagesCache()
})

describe('transcript JSONL round trip', () => {
  test('recordTranscript writes entries that loadTranscriptFile reads back', async () => {
    const messages = [
      userMessage('11111111-1111-4111-8111-111111111111', 'first prompt'),
      assistantMessage('22222222-2222-4222-8222-222222222222', 'first reply'),
      userMessage('33333333-3333-4333-8333-333333333333', 'second prompt'),
    ]

    await recordTranscript(messages)
    await flushSessionStorage()

    const { messages: loaded } = await loadTranscriptFile(sessionFile)

    expect(loaded.size).toBe(3)
    expect([...loaded.keys()]).toEqual([
      '11111111-1111-4111-8111-111111111111' as UUID,
      '22222222-2222-4222-8222-222222222222' as UUID,
      '33333333-3333-4333-8333-333333333333' as UUID,
    ])
  }, 60_000)

  test('round-tripped entries keep their type and message content', async () => {
    await recordTranscript([
      userMessage('11111111-1111-4111-8111-111111111111', 'first prompt'),
      assistantMessage('22222222-2222-4222-8222-222222222222', 'first reply'),
    ])
    await flushSessionStorage()

    const { messages: loaded } = await loadTranscriptFile(sessionFile)

    const user = loaded.get('11111111-1111-4111-8111-111111111111' as UUID)
    const assistant = loaded.get('22222222-2222-4222-8222-222222222222' as UUID)

    expect(user?.type).toBe('user')
    expect(user?.message?.content).toBe('first prompt')
    expect(assistant?.type).toBe('assistant')
    expect(assistant?.message?.content).toEqual([
      { type: 'text', text: 'first reply' },
    ])
  }, 60_000)

  test('insertMessageChain stamps a linear parentUuid chain', async () => {
    await recordTranscript([
      userMessage('11111111-1111-4111-8111-111111111111', 'first prompt'),
      assistantMessage('22222222-2222-4222-8222-222222222222', 'first reply'),
      userMessage('33333333-3333-4333-8333-333333333333', 'second prompt'),
    ])
    await flushSessionStorage()

    const { messages: loaded } = await loadTranscriptFile(sessionFile)

    // The first message of a fresh chain has no parent; every later one
    // points at its immediate predecessor.
    expect(
      loaded.get('11111111-1111-4111-8111-111111111111' as UUID)?.parentUuid,
    ).toBeNull()
    expect(
      loaded.get('22222222-2222-4222-8222-222222222222' as UUID)?.parentUuid,
    ).toBe('11111111-1111-4111-8111-111111111111' as UUID)
    expect(
      loaded.get('33333333-3333-4333-8333-333333333333' as UUID)?.parentUuid,
    ).toBe('22222222-2222-4222-8222-222222222222' as UUID)
  }, 60_000)

  test('the loaded chain rebuilds in write order from the leaf', async () => {
    await recordTranscript([
      userMessage('11111111-1111-4111-8111-111111111111', 'first prompt'),
      assistantMessage('22222222-2222-4222-8222-222222222222', 'first reply'),
      userMessage('33333333-3333-4333-8333-333333333333', 'second prompt'),
    ])
    await flushSessionStorage()

    const { messages: loaded, leafUuids } =
      await loadTranscriptFile(sessionFile)

    // The last chain participant is the only leaf of a linear transcript.
    expect([...leafUuids]).toEqual([
      '33333333-3333-4333-8333-333333333333' as UUID,
    ])

    const leaf = loaded.get('33333333-3333-4333-8333-333333333333' as UUID)!
    const chain = buildConversationChain(loaded, leaf)
    expect(chain.map(m => m.uuid)).toEqual([
      '11111111-1111-4111-8111-111111111111' as UUID,
      '22222222-2222-4222-8222-222222222222' as UUID,
      '33333333-3333-4333-8333-333333333333' as UUID,
    ])
  }, 60_000)

  test('write-path fields are stamped onto every persisted entry', async () => {
    await recordTranscript([
      userMessage('11111111-1111-4111-8111-111111111111', 'first prompt'),
    ])
    await flushSessionStorage()

    const { messages: loaded } = await loadTranscriptFile(sessionFile)
    const entry = loaded.get('11111111-1111-4111-8111-111111111111' as UUID)!

    // These are added by insertMessageChain, not by the caller — a split that
    // relocates the stamping must keep them or --resume loses its anchors.
    expect(entry.sessionId).toBe(getSessionId())
    expect(entry.isSidechain).toBe(false)
    expect(typeof entry.cwd).toBe('string')
    expect(typeof entry.version).toBe('string')
    expect(typeof entry.timestamp).toBe('string')
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false)
  }, 60_000)

  test('re-recording already-persisted messages does not duplicate them', async () => {
    const messages = [
      userMessage('11111111-1111-4111-8111-111111111111', 'first prompt'),
      assistantMessage('22222222-2222-4222-8222-222222222222', 'first reply'),
    ]

    await recordTranscript(messages)
    await flushSessionStorage()
    // Callers pass growing slices of the same conversation every turn, so the
    // UUID dedup in appendEntry is what keeps the file from doubling.
    await recordTranscript([
      ...messages,
      userMessage('33333333-3333-4333-8333-333333333333', 'second prompt'),
    ])
    await flushSessionStorage()

    const { messages: loaded } = await loadTranscriptFile(sessionFile)
    expect(loaded.size).toBe(3)
    // The new message still chains onto the last already-recorded one.
    expect(
      loaded.get('33333333-3333-4333-8333-333333333333' as UUID)?.parentUuid,
    ).toBe('22222222-2222-4222-8222-222222222222' as UUID)
  }, 60_000)

  test('recordTranscript returns the uuid of the last recorded chain participant', async () => {
    const last = await recordTranscript([
      userMessage('11111111-1111-4111-8111-111111111111', 'first prompt'),
      assistantMessage('22222222-2222-4222-8222-222222222222', 'first reply'),
    ])
    expect(last).toBe('22222222-2222-4222-8222-222222222222' as UUID)
  }, 60_000)

  test('loadTranscriptFile returns empty maps for a file that does not exist', async () => {
    const { messages: loaded, leafUuids } = await loadTranscriptFile(
      join(tempDir, 'projects', 'no-such-session.jsonl'),
    )
    expect(loaded.size).toBe(0)
    expect(leafUuids.size).toBe(0)
  }, 60_000)
})
