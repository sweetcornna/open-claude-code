import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { setupGptTuningMock } from '../../../../tests/mocks/gptTuning'
import { logMock } from '../../../../tests/mocks/log'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const gptTuning = setupGptTuningMock()

const { getPlanModeInstructions } = await import('../planModeInstructions.js')
const { resetCliSessionOptions, setCliSessionOptions } = await import(
  '@open-claude-code/tool-runtime/cliSessionOptions.js'
)

/**
 * The Phase 1 and Phase 2 fragments exactly as the non-GPT path must keep
 * emitting them — this attachment feeds the prompt cache, so a stray byte on
 * the Anthropic path is a regression even though it reads harmless.
 */
const PHASE1_DEFAULT = `2. **Launch up to 3 Explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - For tasks with well-known file targets, 1 agent may suffice. In most cases, prefer launching 2-3 agents with complementary search focuses to maximize coverage.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum. Do NOT skip exploration — always use at least 1 Explore agent in Phase 1.
   - When using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns`

const PHASE2_DEFAULT = `Launch Plan agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)`

const originalEnv = {
  agentCount: process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT,
  exploreAgentCount: process.env.CLAUDE_CODE_PLAN_V2_EXPLORE_AGENT_COUNT,
  interviewPhase: process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE,
  userType: process.env.USER_TYPE,
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  // Pinned, never `reset()`: the real gate reads the developer's provider
  // settings, and on an openai-configured machine getMainLoopModel() reaches
  // auth, which throws under NODE_ENV=test without an Anthropic credential.
  gptTuning.set({ isGptTuningActive: () => false })
  delete process.env.USER_TYPE
  // Agent counts come from the subscription tier otherwise, which reads auth.
  process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT = '1'
  process.env.CLAUDE_CODE_PLAN_V2_EXPLORE_AGENT_COUNT = '3'
  // The 5-phase workflow is the branch that carries the agent requirements.
  process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE = '0'
})

afterAll(() => {
  gptTuning.reset()
  restore('CLAUDE_CODE_PLAN_V2_AGENT_COUNT', originalEnv.agentCount)
  restore(
    'CLAUDE_CODE_PLAN_V2_EXPLORE_AGENT_COUNT',
    originalEnv.exploreAgentCount,
  )
  restore('CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE', originalEnv.interviewPhase)
  restore('USER_TYPE', originalEnv.userType)
})

function renderPlanModeInstructions(
  overrides: {
    reminderType?: 'full' | 'sparse'
    customInstructions?: string
  } = {},
): string {
  return getPlanModeInstructions({
    reminderType: 'full',
    planFilePath: '/tmp/plan.md',
    planExists: false,
    ...overrides,
  })
    .map(message => {
      const { content } = message.message
      if (typeof content === 'string') return content
      return (content ?? [])
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('\n')
    })
    .join('\n')
}

describe('getPlanModeInstructions — 5-phase workflow', () => {
  test('keeps the mandatory-agent wording off the GPT path', () => {
    const instructions = renderPlanModeInstructions()
    expect(instructions).toContain(PHASE1_DEFAULT)
    expect(instructions).toContain(PHASE2_DEFAULT)
  })

  test('GPT sessions get the restrained exploration wording', () => {
    gptTuning.set({ isGptTuningActive: () => true })
    const instructions = renderPlanModeInstructions()

    expect(instructions).not.toContain('Do NOT skip exploration')
    expect(instructions).not.toContain('IN PARALLEL')
    expect(instructions).toContain(
      '**Use at most 1 Explore agent, and only when the scope is genuinely unclear.**',
    )
    expect(instructions).toContain('do not delegate')
  })

  test('GPT sessions design without a Plan agent by default', () => {
    gptTuning.set({ isGptTuningActive: () => true })
    const instructions = renderPlanModeInstructions()

    expect(instructions).not.toContain(
      'Launch at least 1 Plan agent for most tasks',
    )
    expect(instructions).toContain('**Default**: Do the design yourself')
  })

  test('leaves the surrounding phases untouched on both paths', () => {
    const withoutTuning = renderPlanModeInstructions()
    gptTuning.set({ isGptTuningActive: () => true })
    const withTuning = renderPlanModeInstructions()

    for (const section of [
      '### Phase 3: Review',
      '### Phase 4: Final Plan',
      '### Phase 5: Call ExitPlanMode',
    ]) {
      expect(withoutTuning).toContain(section)
      expect(withTuning).toContain(section)
    }
  })
})

describe('getPlanModeInstructions — --plan-mode-instructions', () => {
  const CUSTOM = 'Step 1: read the ticket.\nStep 2: write the plan.'

  test('replaces the phase workflow with the supplied body', () => {
    const instructions = renderPlanModeInstructions({
      customInstructions: CUSTOM,
    })

    expect(instructions).toContain(CUSTOM)
    for (const phase of [
      '### Phase 1: Initial Understanding',
      '### Phase 2: Design',
      '### Phase 3: Review',
      '### Phase 4: Final Plan',
      '### Phase 5: Call ExitPlanMode',
    ]) {
      expect(instructions).not.toContain(phase)
    }
  })

  test('keeps the read-only preamble and the ExitPlanMode protocol', () => {
    const instructions = renderPlanModeInstructions({
      customInstructions: CUSTOM,
    })

    expect(instructions).toContain(
      'Plan mode is active. The user indicated that they do not want you to execute yet',
    )
    expect(instructions).toContain(
      'this is the only file you are allowed to edit',
    )
    expect(instructions).toContain('### Call ExitPlanMode')
    expect(instructions).toContain(
      'your turn should only end with either using the AskUserQuestion tool OR calling ExitPlanMode',
    )
  })

  test('the sparse reminder points back at the custom workflow', () => {
    expect(
      renderPlanModeInstructions({
        reminderType: 'sparse',
        customInstructions: CUSTOM,
      }),
    ).toContain('Follow the plan workflow described earlier.')

    expect(renderPlanModeInstructions({ reminderType: 'sparse' })).toContain(
      'Follow 5-phase workflow.',
    )
  })

  test('an absent override leaves the default workflow byte-identical', () => {
    expect(renderPlanModeInstructions({ customInstructions: undefined })).toBe(
      renderPlanModeInstructions(),
    )
    expect(renderPlanModeInstructions()).toContain(
      '### Phase 5: Call ExitPlanMode',
    )
  })
})

describe('getPlanModeInstructions — CLI store wiring', () => {
  afterEach(() => resetCliSessionOptions())

  test('reads --plan-mode-instructions from the CLI session store', () => {
    setCliSessionOptions({ planModeInstructions: 'Just write the plan.' })
    const instructions = renderPlanModeInstructions()

    expect(instructions).toContain('Just write the plan.')
    expect(instructions).not.toContain('### Phase 1: Initial Understanding')
    expect(instructions).toContain('### Call ExitPlanMode')
  })

  test('an explicit argument beats the store', () => {
    setCliSessionOptions({ planModeInstructions: 'from the store' })
    expect(
      renderPlanModeInstructions({ customInstructions: 'from the caller' }),
    ).toContain('from the caller')
  })

  test('subagents never get the custom workflow', () => {
    setCliSessionOptions({ planModeInstructions: 'from the store' })
    const messages = getPlanModeInstructions({
      reminderType: 'full',
      isSubAgent: true,
      planFilePath: '/tmp/plan.md',
      planExists: false,
    })
    const text = JSON.stringify(messages)
    expect(text).not.toContain('from the store')
    expect(text).toContain('Plan mode is active')
  })
})
