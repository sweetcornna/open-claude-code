import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { logMock } from '../../../../../../tests/mocks/log'
import { setupGptTuningMock } from '../../../../../../tests/mocks/gptTuning'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const gptTuning = setupGptTuningMock()

const { getEnterPlanModeToolPrompt } = await import('../prompt.js')

// Phrase unique to each variant: the ant/GPT copy tells the model to start
// working, the external copy tells it to prefer planning.
const RESTRAINED = 'just get started'
const PLAN_FIRST = 'err on the side of planning'

const originalUserType = process.env.USER_TYPE

beforeEach(() => {
  // Pinned, never `reset()`: the real gate reads the developer's provider
  // settings, and on an openai-configured machine getMainLoopModel() reaches
  // auth, which throws under NODE_ENV=test without an Anthropic credential.
  gptTuning.set({ isGptTuningActive: () => false })
  delete process.env.USER_TYPE
  // Keep the interview-phase branch off so both variants render the same
  // surrounding sections.
  process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE = '0'
})

afterAll(() => {
  gptTuning.reset()
  delete process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE
  if (originalUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = originalUserType
})

describe('getEnterPlanModeToolPrompt', () => {
  test('external users get the plan-first copy', () => {
    const prompt = getEnterPlanModeToolPrompt()
    expect(prompt).toContain(PLAN_FIRST)
    expect(prompt).not.toContain(RESTRAINED)
  })

  test('ant users get the restrained copy', () => {
    process.env.USER_TYPE = 'ant'
    const prompt = getEnterPlanModeToolPrompt()
    expect(prompt).toContain(RESTRAINED)
    expect(prompt).not.toContain(PLAN_FIRST)
  })

  test('GPT sessions get the restrained copy without USER_TYPE', () => {
    gptTuning.set({ isGptTuningActive: () => true })
    const prompt = getEnterPlanModeToolPrompt()
    expect(prompt).toContain(RESTRAINED)
    expect(prompt).not.toContain(PLAN_FIRST)
  })
})
