/**
 * Guards the seam created by splitting `runHeadlessStreaming` apart.
 *
 * WHY THIS FILE EXISTS
 * `tests/integration/headless-ndjson.test.ts` pins the NDJSON wire contract,
 * but it deliberately does not execute `runHeadlessStreaming` — see its
 * header. So nothing else in the suite actually *loads* the thirteen modules
 * the streaming session was split into.
 *
 * That gap matters for exactly one failure mode tsc cannot see: ESM
 * initialization order. The split modules reference each other both ways
 * (turn loop → command drain → MCP runtime; control chain → turn loop;
 * plugins → MCP runtime → mcpServers). Those references are all inside
 * function bodies, so the cycles are benign — but if any future edit hoists
 * one to module-init scope, the import graph throws a TDZ ReferenceError at
 * startup and every type check still passes. Importing the graph here turns
 * that into a test failure instead of a runtime crash in `-p` mode.
 *
 * The second half exercises the state factory, which is the only piece of the
 * split with logic of its own rather than moved code.
 */
import { describe, expect, test } from 'bun:test'
import type { QueuedCommand } from 'src/types/textInputTypes.js'

describe('headless module graph', () => {
  test('every split module loads and exports its entry points', async () => {
    const [
      runState,
      mcpRuntime,
      plugins,
      commandDrain,
      teammates,
      teardown,
      turnLoop,
      cron,
      controlResponses,
      mcpControl,
      oauthControl,
      controlRequests,
      stdin,
      streaming,
    ] = await Promise.all([
      import('../headlessRunState.js'),
      import('../headlessMcpRuntime.js'),
      import('../headlessPlugins.js'),
      import('../headlessCommandDrain.js'),
      import('../headlessTeammates.js'),
      import('../headlessTeardown.js'),
      import('../headlessTurnLoop.js'),
      import('../headlessCron.js'),
      import('../headlessControlResponses.js'),
      import('../headlessMcpControl.js'),
      import('../headlessOAuthControl.js'),
      import('../headlessControlRequests.js'),
      import('../headlessStdin.js'),
      import('../runHeadlessStreaming.js'),
    ])

    expect(typeof runState.createHeadlessRunState).toBe('function')
    expect(typeof runState.isMainThreadCommand).toBe('function')
    expect(typeof mcpRuntime.registerElicitationHandlers).toBe('function')
    expect(typeof mcpRuntime.updateSdkMcp).toBe('function')
    expect(typeof mcpRuntime.buildAllTools).toBe('function')
    expect(typeof mcpRuntime.applyMcpServerChanges).toBe('function')
    expect(typeof mcpRuntime.buildMcpServerStatuses).toBe('function')
    expect(typeof plugins.installPluginsAndApplyMcpInBackground).toBe(
      'function',
    )
    expect(typeof plugins.refreshPluginState).toBe('function')
    expect(typeof plugins.applyPluginMcpDiff).toBe('function')
    expect(typeof plugins.resolveDeferredPluginInstall).toBe('function')
    expect(typeof commandDrain.drainCommandQueue).toBe('function')
    expect(typeof teammates.pollTeamLeadInbox).toBe('function')
    expect(typeof teammates.hasActiveSwarmNeedingShutdown).toBe('function')
    expect(typeof teardown.finalizeHeadlessOutput).toBe('function')
    expect(typeof turnLoop.runHeadlessTurn).toBe('function')
    expect(typeof cron.startHeadlessCronScheduler).toBe('function')
    expect(typeof controlResponses.sendControlResponseSuccess).toBe('function')
    expect(typeof controlResponses.sendControlResponseError).toBe('function')
    expect(typeof mcpControl.handleMcpReconnect).toBe('function')
    expect(typeof mcpControl.handleMcpToggle).toBe('function')
    expect(typeof mcpControl.handleChannelEnableRequest).toBe('function')
    expect(typeof oauthControl.handleMcpAuthenticate).toBe('function')
    expect(typeof oauthControl.handleClaudeAuthenticate).toBe('function')
    expect(typeof controlRequests.handleHeadlessControlRequest).toBe('function')
    expect(typeof stdin.runHeadlessInputLoop).toBe('function')
    expect(typeof streaming.runHeadlessStreaming).toBe('function')
  })

  test('print.ts keeps its published surface', async () => {
    const print = await import('../../print.js')
    // Nine runtime symbols. The type-only exports (DynamicMcpState,
    // McpSetServersResult, SdkMcpState) are erased and not asserted here.
    expect(Object.keys(print).sort()).toEqual([
      'canBatchWith',
      'createCanUseToolWithPermissionPrompt',
      'getCanUseToolFn',
      'handleMcpSetServers',
      'handleOrphanedPermissionResponse',
      'joinPromptValues',
      'reconcileMcpServers',
      'removeInterruptedMessage',
      'runHeadless',
    ])
  })
})

describe('isMainThreadCommand', () => {
  test('accepts commands with no agentId and rejects subagent commands', async () => {
    const { isMainThreadCommand } = await import('../headlessRunState.js')
    expect(isMainThreadCommand({ mode: 'prompt' } as QueuedCommand)).toBe(true)
    expect(
      isMainThreadCommand({ mode: 'prompt', agentId: 'a1' } as QueuedCommand),
    ).toBe(false)
  })
})
