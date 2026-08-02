/**
 * Host facade for session-global bootstrap state consumed by builtin tools.
 *
 * Tool runtime cannot import the host bootstrap implementation without
 * recreating the dependency cycle this facade removes. The host registers its
 * implementation before builtin tool modules load. Unlike facades with a true
 * native equivalent, bootstrap-state getters and setters cannot safely fall
 * back: a default value would hide registration-order bugs. Every unregistered
 * call therefore fails fast and names both this facade and the requested symbol.
 */

import type { Attributes } from '@opentelemetry/api'

export type SessionId = string & { readonly __brand: 'SessionId' }

export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

export type AgentColorName =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan'

export type AttributedCounter = {
  add(value: number, additionalAttributes?: Attributes): void
}

export interface BootstrapStateHost {
  getProjectRoot(): string
  getSessionId(): SessionId
  getOriginalCwd(): string
  setOriginalCwd(cwd: string): void
  setProjectRoot(cwd: string): void
  getAllowedChannels(): ChannelEntry[]
  getKairosActive(): boolean
  getIsNonInteractiveSession(): boolean
  getSdkAgentProgressSummariesEnabled(): boolean
  getQuestionPreviewFormat(): 'markdown' | 'html' | undefined
  getUserMsgOptIn(): boolean
  clearInvokedSkillsForAgent(agentId: string): void
  addInvokedSkill(
    skillName: string,
    skillPath: string,
    content: string,
    agentId?: string | null,
  ): void
  getAgentColorMap(): Map<string, AgentColorName>
  handlePlanModeTransition(fromMode: string, toMode: string): void
  hasExitedPlanModeInSession(): boolean
  setHasExitedPlanMode(value: boolean): void
  setNeedsAutoModeExitAttachment(value: boolean): void
  setNeedsPlanModeExitAttachment(value: boolean): void
  setScheduledTasksEnabled(enabled: boolean): void
  getCommitCounter(): AttributedCounter | null
  getPrCounter(): AttributedCounter | null
}

let host: BootstrapStateHost | null = null

export function registerBootstrapStateHost(h: BootstrapStateHost): void {
  host = h
}

function getHost(symbol: keyof BootstrapStateHost): BootstrapStateHost {
  if (!host) {
    throw new Error(
      `bootstrapState facade host is not registered; cannot call ${symbol}`,
    )
  }
  return host
}

export function getProjectRoot(): string {
  return getHost('getProjectRoot').getProjectRoot()
}

export function getSessionId(): SessionId {
  return getHost('getSessionId').getSessionId()
}

export function getOriginalCwd(): string {
  return getHost('getOriginalCwd').getOriginalCwd()
}

export function setOriginalCwd(cwd: string): void {
  getHost('setOriginalCwd').setOriginalCwd(cwd)
}

export function setProjectRoot(cwd: string): void {
  getHost('setProjectRoot').setProjectRoot(cwd)
}

export function getAllowedChannels(): ChannelEntry[] {
  return getHost('getAllowedChannels').getAllowedChannels()
}

export function getKairosActive(): boolean {
  return getHost('getKairosActive').getKairosActive()
}

export function getIsNonInteractiveSession(): boolean {
  return getHost('getIsNonInteractiveSession').getIsNonInteractiveSession()
}

export function getSdkAgentProgressSummariesEnabled(): boolean {
  return getHost(
    'getSdkAgentProgressSummariesEnabled',
  ).getSdkAgentProgressSummariesEnabled()
}

export function getQuestionPreviewFormat(): 'markdown' | 'html' | undefined {
  return getHost('getQuestionPreviewFormat').getQuestionPreviewFormat()
}

export function getUserMsgOptIn(): boolean {
  return getHost('getUserMsgOptIn').getUserMsgOptIn()
}

export function clearInvokedSkillsForAgent(agentId: string): void {
  getHost('clearInvokedSkillsForAgent').clearInvokedSkillsForAgent(agentId)
}

export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  getHost('addInvokedSkill').addInvokedSkill(
    skillName,
    skillPath,
    content,
    agentId,
  )
}

export function getAgentColorMap(): Map<string, AgentColorName> {
  return getHost('getAgentColorMap').getAgentColorMap()
}

export function handlePlanModeTransition(
  fromMode: string,
  toMode: string,
): void {
  getHost('handlePlanModeTransition').handlePlanModeTransition(fromMode, toMode)
}

export function hasExitedPlanModeInSession(): boolean {
  return getHost('hasExitedPlanModeInSession').hasExitedPlanModeInSession()
}

export function setHasExitedPlanMode(value: boolean): void {
  getHost('setHasExitedPlanMode').setHasExitedPlanMode(value)
}

export function setNeedsAutoModeExitAttachment(value: boolean): void {
  getHost('setNeedsAutoModeExitAttachment').setNeedsAutoModeExitAttachment(
    value,
  )
}

export function setNeedsPlanModeExitAttachment(value: boolean): void {
  getHost('setNeedsPlanModeExitAttachment').setNeedsPlanModeExitAttachment(
    value,
  )
}

export function setScheduledTasksEnabled(enabled: boolean): void {
  getHost('setScheduledTasksEnabled').setScheduledTasksEnabled(enabled)
}

export function getCommitCounter(): AttributedCounter | null {
  return getHost('getCommitCounter').getCommitCounter()
}

export function getPrCounter(): AttributedCounter | null {
  return getHost('getPrCounter').getPrCounter()
}
