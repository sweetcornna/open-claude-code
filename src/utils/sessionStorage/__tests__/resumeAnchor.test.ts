/**
 * The third gate on auto-continuing an interrupted turn: the anchor that stops
 * the SAME tail from being offered twice.
 *
 * The other two gates (age, and "was anything interrupted at all") are covered
 * in-memory by src/utils/session/__tests__/resumeInterruptedTurnGates.test.ts.
 * This one has to go through the disk format, because the whole point of the
 * anchor is that it survives the process that wrote it — a purely in-memory
 * test would pass just as happily against the version where nothing was ever
 * persisted.
 *
 * Real files, no module mocks: the thing under test IS the JSONL round trip.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { occConfigDir } from 'src/config/paths.js'
import type { Message } from 'src/types/message.js'
import { deserializeMessagesWithInterruptDetection } from 'src/utils/session/conversationRecovery.js'
import { resetStateForTests, setOriginalCwd } from '../../../bootstrap/state.js'
import { getLastSessionLog } from '../logAssembly.js'
import { getProjectDir } from '../paths.js'
import { saveResumeAnchor } from '../sessionMetadata.js'

const SESSION_ID = '11111111-1111-4111-8111-111111111111' as UUID
const PROMPT_UUID = '22222222-2222-4222-8222-222222222222' as UUID
const ASSISTANT_UUID = '33333333-3333-4333-8333-333333333333' as UUID
const RESULT_UUID = '44444444-4444-4444-8444-444444444444' as UUID

const originalConfigDir = process.env.OCC_CONFIG_DIR
let root = ''
let project = ''
let sessionFile = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'occ-anchor-rt-'))
  project = join(root, 'project')
  process.env.OCC_CONFIG_DIR = join(root, 'config')
  occConfigDir.cache.clear?.()
  getProjectDir.cache.clear?.()
  setOriginalCwd(project)
  sessionFile = join(getProjectDir(project), `${SESSION_ID}.jsonl`)
  await mkdir(dirname(sessionFile), { recursive: true })
  await writeFile(sessionFile, interruptedToolTurnJsonl())
})

afterEach(async () => {
  resetStateForTests()
  if (originalConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = originalConfigDir
  occConfigDir.cache.clear?.()
  getProjectDir.cache.clear?.()
  await rm(root, { recursive: true, force: true })
})

/**
 * Assistant tool_use followed by its tool_result and nothing else: the "killed
 * while running a tool" shape, which detection reports as an interrupted turn
 * and which therefore earns a synthetic continuation. Timestamps are seconds
 * old, so the age gate stays out of the way.
 */
function interruptedToolTurnJsonl(): string {
  // Timestamps must strictly increase: getLastSessionLog picks the chain tip
  // with findLatestMessage, which is a max-by-timestamp — give all three the
  // same instant and it anchors on the first line and returns a one-message
  // transcript, which is a different (and much less interesting) fixture.
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
  const base = { sessionId: SESSION_ID, cwd: project, version: '0' }
  return (
    [
      {
        ...base,
        timestamp: at(3000),
        type: 'user',
        uuid: PROMPT_UUID,
        parentUuid: null,
        message: { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      },
      {
        ...base,
        timestamp: at(2000),
        type: 'assistant',
        uuid: ASSISTANT_UUID,
        parentUuid: PROMPT_UUID,
        message: {
          id: 'msg_assistant',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
          ],
        },
      },
      {
        ...base,
        timestamp: at(1000),
        type: 'user',
        uuid: RESULT_UUID,
        parentUuid: ASSISTANT_UUID,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
          ],
        },
      },
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n') + '\n'
  )
}

function continuationTexts(messages: Message[]): string[] {
  return messages.flatMap(message => {
    const content = message.message?.content
    if (!Array.isArray(content)) return []
    return content.flatMap(block =>
      typeof block === 'object' && block?.type === 'text' ? [block.text] : [],
    )
  })
}

describe('resume anchor round trip', () => {
  test('the same tail offered twice is suppressed the second time', async () => {
    // Pass 1: nothing on disk yet, so the offer is made and it names the tail
    // it was made against.
    const first = await getLastSessionLog(SESSION_ID)
    expect(first?.resumeAnchorUuid).toBeUndefined()

    const firstResult = deserializeMessagesWithInterruptDetection(
      first!.messages,
      { resumeAnchorUuid: first?.resumeAnchorUuid },
    )
    expect(firstResult.turnInterruptionState.kind).toBe('interrupted_prompt')
    const anchor =
      firstResult.turnInterruptionState.kind === 'interrupted_prompt'
        ? firstResult.turnInterruptionState.resumeAnchorUuid
        : undefined
    // The tool_result is the transcript tail, NOT the synthetic continuation
    // the deserializer just appended.
    expect(anchor).toBe(RESULT_UUID)
    expect(continuationTexts(firstResult.messages)).toContain(
      'Continue from where you left off.',
    )

    // What the consumer of the offer does before acting on it.
    saveResumeAnchor(SESSION_ID, anchor as UUID, sessionFile)

    // Pass 2: same transcript, nothing appended by the run that was offered
    // the continuation — the crash-loop case.
    const second = await getLastSessionLog(SESSION_ID)
    expect(second?.resumeAnchorUuid).toBe(RESULT_UUID)

    const secondResult = deserializeMessagesWithInterruptDetection(
      second!.messages,
      { resumeAnchorUuid: second?.resumeAnchorUuid },
    )
    expect(secondResult.turnInterruptionState.kind).toBe('none')
    expect(continuationTexts(secondResult.messages)).not.toContain(
      'Continue from where you left off.',
    )
  })

  test('an anchor from an older tail does not suppress a newer turn', async () => {
    // The anchor names the user prompt, but the transcript has since grown a
    // tool call — this is a different interruption and must still be offered.
    saveResumeAnchor(SESSION_ID, PROMPT_UUID, sessionFile)

    const log = await getLastSessionLog(SESSION_ID)
    expect(log?.resumeAnchorUuid).toBe(PROMPT_UUID)

    const result = deserializeMessagesWithInterruptDetection(log!.messages, {
      resumeAnchorUuid: log?.resumeAnchorUuid,
    })
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
  })

  test('a transcript written before the entry existed keeps the old behaviour', async () => {
    // Back-compat: no resume-anchor line anywhere in the file.
    const raw = await readFile(sessionFile, 'utf-8')
    expect(raw.includes('"type":"resume-anchor"')).toBe(false)

    const log = await getLastSessionLog(SESSION_ID)
    expect(log?.resumeAnchorUuid).toBeUndefined()

    const result = deserializeMessagesWithInterruptDetection(log!.messages, {
      resumeAnchorUuid: log?.resumeAnchorUuid,
    })
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(continuationTexts(result.messages)).toContain(
      'Continue from where you left off.',
    )
  })

  test('the newest anchor wins when several were written', async () => {
    saveResumeAnchor(SESSION_ID, PROMPT_UUID, sessionFile)
    saveResumeAnchor(SESSION_ID, RESULT_UUID, sessionFile)

    const log = await getLastSessionLog(SESSION_ID)
    expect(log?.resumeAnchorUuid).toBe(RESULT_UUID)
  })
})
