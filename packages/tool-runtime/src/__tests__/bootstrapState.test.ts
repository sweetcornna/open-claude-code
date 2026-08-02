import { describe, expect, mock, test } from 'bun:test'
import type {
  AgentColorName,
  AttributedCounter,
  BootstrapStateHost,
  ChannelEntry,
  SessionId,
} from '../bootstrapState.js'

async function loadFacade() {
  return import(`../bootstrapState.ts?case=${Math.random()}`)
}

describe('bootstrapState facade', () => {
  test('fails fast with the facade and symbol names when unregistered', async () => {
    const facade = await loadFacade()
    const calls: Array<[keyof BootstrapStateHost, () => unknown]> = [
      ['getProjectRoot', () => facade.getProjectRoot()],
      ['getSessionId', () => facade.getSessionId()],
      ['getOriginalCwd', () => facade.getOriginalCwd()],
      ['setOriginalCwd', () => facade.setOriginalCwd('/original')],
      ['setProjectRoot', () => facade.setProjectRoot('/project')],
      ['getAllowedChannels', () => facade.getAllowedChannels()],
      ['getKairosActive', () => facade.getKairosActive()],
      ['getIsNonInteractiveSession', () => facade.getIsNonInteractiveSession()],
      [
        'getSdkAgentProgressSummariesEnabled',
        () => facade.getSdkAgentProgressSummariesEnabled(),
      ],
      ['getQuestionPreviewFormat', () => facade.getQuestionPreviewFormat()],
      ['getUserMsgOptIn', () => facade.getUserMsgOptIn()],
      [
        'clearInvokedSkillsForAgent',
        () => facade.clearInvokedSkillsForAgent('agent-1'),
      ],
      [
        'addInvokedSkill',
        () => facade.addInvokedSkill('skill', '/skill', 'content'),
      ],
      ['getAgentColorMap', () => facade.getAgentColorMap()],
      [
        'handlePlanModeTransition',
        () => facade.handlePlanModeTransition('default', 'plan'),
      ],
      ['hasExitedPlanModeInSession', () => facade.hasExitedPlanModeInSession()],
      ['setHasExitedPlanMode', () => facade.setHasExitedPlanMode(true)],
      [
        'setNeedsAutoModeExitAttachment',
        () => facade.setNeedsAutoModeExitAttachment(true),
      ],
      [
        'setNeedsPlanModeExitAttachment',
        () => facade.setNeedsPlanModeExitAttachment(true),
      ],
      ['setScheduledTasksEnabled', () => facade.setScheduledTasksEnabled(true)],
      ['getCommitCounter', () => facade.getCommitCounter()],
      ['getPrCounter', () => facade.getPrCounter()],
    ]

    for (const [symbol, call] of calls) {
      expect(call).toThrow('bootstrapState facade host is not registered')
      expect(call).toThrow(symbol)
    }
  })

  test('delegates all calls to the registered host', async () => {
    const facade = await loadFacade()
    const sessionId = 'session-1' as SessionId
    const channels: ChannelEntry[] = [
      { kind: 'plugin', name: 'channel', marketplace: 'marketplace' },
    ]
    const agentColorMap = new Map<string, AgentColorName>([
      ['reviewer', 'blue'],
    ])
    const counter = {
      add: mock((_value: number) => {}),
    } satisfies AttributedCounter
    const host = {
      getProjectRoot: mock(() => '/project'),
      getSessionId: mock(() => sessionId),
      getOriginalCwd: mock(() => '/original'),
      setOriginalCwd: mock((_cwd: string) => {}),
      setProjectRoot: mock((_cwd: string) => {}),
      getAllowedChannels: mock(() => channels),
      getKairosActive: mock(() => true),
      getIsNonInteractiveSession: mock(() => true),
      getSdkAgentProgressSummariesEnabled: mock(() => true),
      getQuestionPreviewFormat: mock(() => 'html' as const),
      getUserMsgOptIn: mock(() => true),
      clearInvokedSkillsForAgent: mock((_agentId: string) => {}),
      addInvokedSkill: mock(
        (
          _skillName: string,
          _skillPath: string,
          _content: string,
          _agentId: string | null = null,
        ) => {},
      ),
      getAgentColorMap: mock(() => agentColorMap),
      handlePlanModeTransition: mock(
        (_fromMode: string, _toMode: string) => {},
      ),
      hasExitedPlanModeInSession: mock(() => true),
      setHasExitedPlanMode: mock((_value: boolean) => {}),
      setNeedsAutoModeExitAttachment: mock((_value: boolean) => {}),
      setNeedsPlanModeExitAttachment: mock((_value: boolean) => {}),
      setScheduledTasksEnabled: mock((_enabled: boolean) => {}),
      getCommitCounter: mock(() => counter),
      getPrCounter: mock(() => counter),
    } satisfies BootstrapStateHost

    facade.registerBootstrapStateHost(host)

    expect(facade.getProjectRoot()).toBe('/project')
    expect(facade.getSessionId()).toBe(sessionId)
    expect(facade.getOriginalCwd()).toBe('/original')
    facade.setOriginalCwd('/next-original')
    facade.setProjectRoot('/next-project')
    expect(facade.getAllowedChannels()).toBe(channels)
    expect(facade.getKairosActive()).toBe(true)
    expect(facade.getIsNonInteractiveSession()).toBe(true)
    expect(facade.getSdkAgentProgressSummariesEnabled()).toBe(true)
    expect(facade.getQuestionPreviewFormat()).toBe('html')
    expect(facade.getUserMsgOptIn()).toBe(true)
    facade.clearInvokedSkillsForAgent('agent-1')
    facade.addInvokedSkill('skill', '/skill', 'content')
    expect(facade.getAgentColorMap()).toBe(agentColorMap)
    facade.handlePlanModeTransition('default', 'plan')
    expect(facade.hasExitedPlanModeInSession()).toBe(true)
    facade.setHasExitedPlanMode(true)
    facade.setNeedsAutoModeExitAttachment(true)
    facade.setNeedsPlanModeExitAttachment(true)
    facade.setScheduledTasksEnabled(true)
    expect(facade.getCommitCounter()).toBe(counter)
    expect(facade.getPrCounter()).toBe(counter)

    expect(host.setOriginalCwd).toHaveBeenCalledWith('/next-original')
    expect(host.setProjectRoot).toHaveBeenCalledWith('/next-project')
    expect(host.clearInvokedSkillsForAgent).toHaveBeenCalledWith('agent-1')
    expect(host.addInvokedSkill).toHaveBeenCalledWith(
      'skill',
      '/skill',
      'content',
      null,
    )
    expect(host.handlePlanModeTransition).toHaveBeenCalledWith(
      'default',
      'plan',
    )
    expect(host.setHasExitedPlanMode).toHaveBeenCalledWith(true)
    expect(host.setNeedsAutoModeExitAttachment).toHaveBeenCalledWith(true)
    expect(host.setNeedsPlanModeExitAttachment).toHaveBeenCalledWith(true)
    expect(host.setScheduledTasksEnabled).toHaveBeenCalledWith(true)
  })
})
