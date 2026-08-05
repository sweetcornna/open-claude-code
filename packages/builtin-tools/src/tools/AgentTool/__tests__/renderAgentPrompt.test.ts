import { describe, expect, test } from 'bun:test'
import { type AgentPromptParams, renderAgentPrompt } from '../prompt.js'

const CONCURRENCY_NOTE = 'Launch multiple agents concurrently whenever possible'
const PROACTIVE_NOTE = 'it should be used proactively'
const PARALLEL_NOTE = 'you MUST send a single message with multiple'

function params(overrides: Partial<AgentPromptParams> = {}): AgentPromptParams {
  return {
    agentLines: ['- Explore: Read-only search agent (Tools: Read, Grep)'],
    isCoordinator: false,
    forkEnabled: false,
    embeddedSearchTools: false,
    includeConcurrencyNote: true,
    suppressProactiveGuidance: false,
    backgroundAgentsAvailable: true,
    antUser: false,
    inProcessTeammate: false,
    teammate: false,
    ...overrides,
  }
}

describe('renderAgentPrompt', () => {
  test('emits the fan-out guidance by default', () => {
    const prompt = renderAgentPrompt(params())
    expect(prompt).toContain(CONCURRENCY_NOTE)
    expect(prompt).toContain(PROACTIVE_NOTE)
    expect(prompt).toContain(PARALLEL_NOTE)
  })

  test('suppressProactiveGuidance drops both usage notes', () => {
    const prompt = renderAgentPrompt(
      params({
        includeConcurrencyNote: false,
        suppressProactiveGuidance: true,
      }),
    )
    expect(prompt).not.toContain(CONCURRENCY_NOTE)
    expect(prompt).not.toContain(PROACTIVE_NOTE)
    expect(prompt).not.toContain(PARALLEL_NOTE)
  })

  test('keeps the when-not-to-use section and the remaining usage notes', () => {
    const suppressed = renderAgentPrompt(
      params({
        includeConcurrencyNote: false,
        suppressProactiveGuidance: true,
      }),
    )
    expect(suppressed).toContain('When NOT to use the Agent tool:')
    expect(suppressed).toContain(
      'Always include a short description (3-5 words)',
    )
    expect(suppressed).toContain('isolation: "worktree"')
    // Dropping the notes must not leave a blank bullet line behind.
    expect(suppressed).not.toMatch(/\n\n-\s*\n/)
  })

  test('suppression is the only difference from the default render', () => {
    const withGuidance = renderAgentPrompt(params())
    const withoutGuidance = renderAgentPrompt(
      params({
        includeConcurrencyNote: false,
        suppressProactiveGuidance: true,
      }),
    )
    const stripped = withGuidance
      .split('\n')
      .filter(
        line =>
          !line.includes(CONCURRENCY_NOTE) &&
          !line.includes(PROACTIVE_NOTE) &&
          !line.includes(PARALLEL_NOTE),
      )
      .join('\n')
    expect(withoutGuidance).toBe(stripped)
  })
})
