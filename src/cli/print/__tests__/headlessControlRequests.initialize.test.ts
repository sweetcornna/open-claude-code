/**
 * Regression test: the `initialize` control request must report (and push
 * stdin-supplied agents into) `state.currentCommands` / `state.currentAgents`,
 * not the construction-time arrays.
 *
 * The failure mode this pins: when the plugin install finishes before
 * `initialize` arrives, `refreshPluginState` has already replaced both
 * arrays. The pre-fix code reported the construction-time command set to the
 * SDK consumer and pushed stdin agents into an array nothing reads.
 *
 * CLAUDE_CODE_USE_BEDROCK is set for the dispatch so getAccountInformation()
 * returns early instead of touching the credential store — no module mocks
 * needed, which keeps this file free of process-global mock.module pollution.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { AgentDefinition } from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { Command } from 'src/commands.js'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { handleHeadlessControlRequest } from '../headlessControlRequests.js'
import type { HeadlessRunState } from '../headlessRunState.js'
import { type AppState, getDefaultAppState } from 'src/state/AppStateStore.js'

const savedBedrock = process.env.CLAUDE_CODE_USE_BEDROCK

beforeAll(() => {
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
})

afterAll(() => {
  if (savedBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
  else process.env.CLAUDE_CODE_USE_BEDROCK = savedBedrock
})

function makeCommand(name: string): Command {
  return {
    type: 'local',
    name,
    description: `${name} description`,
    isEnabled: () => true,
    isHidden: false,
    call: async () => '',
  } as unknown as Command
}

function makeAgent(agentType: string): AgentDefinition {
  return {
    agentType,
    whenToUse: `${agentType} when-to-use`,
    source: 'plugin',
    getSystemPrompt: () => '',
  } as unknown as AgentDefinition
}

function makeState(overrides: Partial<HeadlessRunState>): {
  state: HeadlessRunState
  outputs: StdoutMessage[]
} {
  const outputs: StdoutMessage[] = []
  const state = {
    initialized: false,
    output: { enqueue: (m: StdoutMessage) => outputs.push(m) },
    modelInfos: [],
    structuredIO: {
      getPendingPermissionRequests: () => [],
    },
    options: {},
    sdkMcpConfigs: {},
    getAppState: () => {
      throw new Error('getAppState should not be needed for initialize')
    },
    ...overrides,
  } as unknown as HeadlessRunState
  return { state, outputs }
}

describe('handleHeadlessControlRequest apply_flag_settings', () => {
  test('applies a runtime auto-compact window to the current session', async () => {
    let appState = getDefaultAppState()
    const { state } = makeState({
      getAppState: () => appState,
      setAppState: updater => {
        appState = updater(appState)
      },
    })

    await handleHeadlessControlRequest(state, {
      type: 'control_request',
      request_id: 'req-autocompact-1',
      request: {
        subtype: 'apply_flag_settings',
        settings: { autoCompactWindow: 500_000 },
      },
    })

    expect(appState.autoCompactWindow).toBe(500_000)
    expect(appState.autoCompactWindowOverride).toBe(true)
  })

  test('treats null as an explicit auto override', async () => {
    let appState: AppState = {
      ...getDefaultAppState(),
      autoCompactWindow: 500_000,
      autoCompactWindowOverride: true,
    }
    const { state } = makeState({
      getAppState: () => appState,
      setAppState: updater => {
        appState = updater(appState)
      },
    })

    await handleHeadlessControlRequest(state, {
      type: 'control_request',
      request_id: 'req-autocompact-2',
      request: {
        subtype: 'apply_flag_settings',
        settings: { autoCompactWindow: null },
      },
    })

    expect(appState.autoCompactWindow).toBeUndefined()
    expect(appState.autoCompactWindowOverride).toBe(true)
  })
})

describe('handleHeadlessControlRequest initialize', () => {
  test('reports currentCommands/currentAgents, not construction-time arrays', async () => {
    // Simulate refreshPluginState having completed before initialize: the
    // current arrays are replacements, and no other array holds the truth.
    const { state, outputs } = makeState({
      currentCommands: [makeCommand('fresh-cmd')],
      currentAgents: [makeAgent('fresh-agent')],
    })

    const result = await handleHeadlessControlRequest(state, {
      type: 'control_request',
      request_id: 'req-init-1',
      request: { subtype: 'initialize' },
    })

    expect(result).toBe('continue')
    expect(state.initialized).toBe(true)

    const response = outputs.find(m => m.type === 'control_response') as
      | (StdoutMessage & { response: Record<string, unknown> })
      | undefined
    expect(response).toBeDefined()
    expect(response?.response.subtype).toBe('success')
    const init = (
      response?.response as {
        response: { commands: { name: string }[]; agents: { name: string }[] }
      }
    ).response
    expect(init.commands.map(c => c.name)).toEqual(['fresh-cmd'])
    expect(init.agents.map(a => a.name)).toEqual(['fresh-agent'])
  })

  test('pushes stdin-supplied agents into currentAgents', async () => {
    const currentAgents = [makeAgent('fresh-agent')]
    const { state } = makeState({
      currentCommands: [],
      currentAgents,
    })

    await handleHeadlessControlRequest(state, {
      type: 'control_request',
      request_id: 'req-init-2',
      request: {
        subtype: 'initialize',
        agents: {
          'stdin-agent': {
            description: 'agent supplied over stdin',
            prompt: 'You are a stdin agent.',
          },
        },
      },
    })

    // The stdin agent must land in the array the command drain reads.
    expect(currentAgents.map(a => a.agentType)).toEqual([
      'fresh-agent',
      'stdin-agent',
    ])
    expect(state.currentAgents).toBe(currentAgents)
  })
})
