import { describe, expect, test } from 'bun:test'
import { AGENT_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/AgentTool/constants.js'
import type { HookEvent, HookInput } from '../../entrypoints/agentSdkTypes.js'
import type { AppState } from '../../state/AppState.js'

// Characterization test for getMatchingHooks' matcher matrix.
//
// hooks.ts is about to be split into leaf modules. The export-surface snapshot
// in hooks.exports.test.ts pins the *names*; this pins the one piece of logic
// that is easy to get subtly wrong when moving code around: how a configured
// `matcher` string is turned into a yes/no decision for a given hook event.
// The rules are non-obvious (alphanumeric matchers are EXACT, not regex;
// anything else is a regex; legacy tool aliases are resolved on both sides;
// several events match on a field other than tool_name) and every one of them
// silently changes which of the user's shell commands run.
//
// No mock.module anywhere. Bun's mock.module is process-global and
// last-write-wins across the whole test process, so mocking settings or the
// hooks-config snapshot here would leak into every other test file. Instead
// hooks are injected per-call through the `appState.sessionHooks` argument
// that getMatchingHooks already accepts, and the assertions read only the
// sentinel commands this file created — any hook the developer happens to
// have in their real settings.json is ignored rather than breaking the test.

const { getMatchingHooks } = await import('../hooks.js')

const SESSION_ID = 'hooks-matcher-matrix-session'
const SENTINEL = 'occ-test-hook:'

type TestHook = {
  type: 'command'
  command: string
  shell?: string
  if?: string
}

/**
 * Build the `appState` shape getMatchingHooks reads: a sessionHooks Map keyed
 * by session id, whose store holds per-event matcher lists. `matcher:
 * undefined` models a settings entry written without a matcher key.
 */
function appStateWith(
  event: HookEvent,
  matchers: Array<{ matcher?: string; hooks: TestHook[] }>,
): AppState {
  return {
    sessionHooks: new Map([
      [
        SESSION_ID,
        {
          hooks: {
            [event]: matchers.map(m => ({
              matcher: m.matcher,
              hooks: m.hooks.map(hook => ({ hook })),
            })),
          },
        },
      ],
    ]),
  } as unknown as AppState
}

/**
 * Run getMatchingHooks and return only the sentinel commands this file
 * injected, so ambient hooks from the developer's own settings can't
 * influence the result.
 */
async function matchedCommands(
  event: HookEvent,
  matchers: Array<{ matcher?: string; hooks: TestHook[] }>,
  hookInput: Record<string, unknown>,
): Promise<string[]> {
  const matched = await getMatchingHooks(
    appStateWith(event, matchers),
    SESSION_ID,
    event,
    hookInput as unknown as HookInput,
  )
  return matched
    .map(m => (m.hook as { command?: string }).command ?? '')
    .filter(command => command.startsWith(SENTINEL))
}

function preToolUse(toolName: string): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: {},
  }
}

function cmd(name: string): TestHook {
  return { type: 'command', command: `${SENTINEL}${name}` }
}

describe('getMatchingHooks matcher matrix — PreToolUse tool names', () => {
  test('an alphanumeric matcher matches the tool name exactly', async () => {
    const matchers = [{ matcher: 'Bash', hooks: [cmd('bash')] }]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Bash')),
    ).toEqual([`${SENTINEL}bash`])
  })

  test('an alphanumeric matcher does not match a different tool', async () => {
    const matchers = [{ matcher: 'Bash', hooks: [cmd('bash')] }]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Read')),
    ).toEqual([])
  })

  test('an alphanumeric matcher is exact, not a substring or prefix match', async () => {
    // 'Edit' must NOT fire for 'MultiEdit' — the plain-string branch compares
    // with === rather than treating the matcher as a regex.
    const matchers = [{ matcher: 'Edit', hooks: [cmd('edit')] }]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('MultiEdit')),
    ).toEqual([])
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Edit')),
    ).toEqual([`${SENTINEL}edit`])
  })

  test('the wildcard matcher matches every tool', async () => {
    const matchers = [{ matcher: '*', hooks: [cmd('star')] }]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Bash')),
    ).toEqual([`${SENTINEL}star`])
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('WebFetch')),
    ).toEqual([`${SENTINEL}star`])
  })

  test('an omitted matcher matches every tool', async () => {
    const matchers = [{ hooks: [cmd('no-matcher')] }]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Bash')),
    ).toEqual([`${SENTINEL}no-matcher`])
  })

  test('an empty-string matcher matches every tool', async () => {
    const matchers = [{ matcher: '', hooks: [cmd('empty')] }]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Glob')),
    ).toEqual([`${SENTINEL}empty`])
  })

  test('a pipe-separated matcher matches any listed tool', async () => {
    const matchers = [{ matcher: 'Bash|Read|Glob', hooks: [cmd('pipe')] }]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Read')),
    ).toEqual([`${SENTINEL}pipe`])
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Glob')),
    ).toEqual([`${SENTINEL}pipe`])
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Write')),
    ).toEqual([])
  })

  test('spaces around a pipe drop the matcher out of the exact-match branch', async () => {
    // 'Bash | Read' fails the /^[a-zA-Z0-9_|]+$/ test, so it is compiled as a
    // regex whose alternatives are 'Bash ' and ' Read'. Neither matches the
    // bare tool name — the .trim() in the pipe branch is unreachable for
    // inputs containing whitespace.
    const matchers = [{ matcher: 'Bash | Read', hooks: [cmd('spaced-pipe')] }]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Read')),
    ).toEqual([])
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Bash')),
    ).toEqual([])
  })
})

describe('getMatchingHooks matcher matrix — regex matchers', () => {
  test('a matcher with regex metacharacters is compiled as a regex', async () => {
    const matchers = [{ matcher: '^Edit$', hooks: [cmd('anchored')] }]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Edit')),
    ).toEqual([`${SENTINEL}anchored`])
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('MultiEdit')),
    ).toEqual([])
  })

  test('an unanchored regex matches anywhere in the tool name', async () => {
    const matchers = [{ matcher: 'mcp__.*', hooks: [cmd('mcp')] }]
    expect(
      await matchedCommands(
        'PreToolUse',
        matchers,
        preToolUse('mcp__github__list_issues'),
      ),
    ).toEqual([`${SENTINEL}mcp`])
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Bash')),
    ).toEqual([])
  })

  test('an invalid regex is skipped without taking the other hooks down', async () => {
    // new RegExp('[') throws; matchesPattern swallows it and returns false.
    // The sibling matcher must still fire — otherwise a single typo in
    // settings.json would silently disable every hook on the event.
    const matchers = [
      { matcher: '[', hooks: [cmd('invalid')] },
      { matcher: 'Bash', hooks: [cmd('valid')] },
    ]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Bash')),
    ).toEqual([`${SENTINEL}valid`])
  })
})

describe('getMatchingHooks matcher matrix — legacy tool aliases', () => {
  test('a legacy alias matcher resolves to the canonical tool name', async () => {
    // Settings written before the rename say 'Task'; the tool now reports
    // AGENT_TOOL_NAME. The exact-match branch normalizes the matcher.
    const matchers = [{ matcher: 'Task', hooks: [cmd('legacy-exact')] }]
    expect(
      await matchedCommands(
        'PreToolUse',
        matchers,
        preToolUse(AGENT_TOOL_NAME),
      ),
    ).toEqual([`${SENTINEL}legacy-exact`])
  })

  test('a regex matcher is also tested against the legacy tool names', async () => {
    // '^Task$' cannot match 'Agent' directly; the regex branch retries against
    // every legacy alias of the canonical name.
    const matchers = [{ matcher: '^Task$', hooks: [cmd('legacy-regex')] }]
    expect(
      await matchedCommands(
        'PreToolUse',
        matchers,
        preToolUse(AGENT_TOOL_NAME),
      ),
    ).toEqual([`${SENTINEL}legacy-regex`])
  })

  test('a legacy alias inside a pipe list resolves too', async () => {
    const matchers = [{ matcher: 'Bash|Task', hooks: [cmd('legacy-pipe')] }]
    expect(
      await matchedCommands(
        'PreToolUse',
        matchers,
        preToolUse(AGENT_TOOL_NAME),
      ),
    ).toEqual([`${SENTINEL}legacy-pipe`])
  })
})

describe('getMatchingHooks matcher matrix — per-event match fields', () => {
  test('PostToolUse matches on tool_name like PreToolUse', async () => {
    const matchers = [{ matcher: 'Bash', hooks: [cmd('post')] }]
    expect(
      await matchedCommands('PostToolUse', matchers, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: {},
        tool_response: {},
      }),
    ).toEqual([`${SENTINEL}post`])
  })

  test('SessionStart matches on source', async () => {
    const matchers = [{ matcher: 'resume', hooks: [cmd('session-start')] }]
    expect(
      await matchedCommands('SessionStart', matchers, {
        hook_event_name: 'SessionStart',
        source: 'resume',
      }),
    ).toEqual([`${SENTINEL}session-start`])
    expect(
      await matchedCommands('SessionStart', matchers, {
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
    ).toEqual([])
  })

  test('PreCompact matches on trigger', async () => {
    const matchers = [{ matcher: 'manual', hooks: [cmd('pre-compact')] }]
    expect(
      await matchedCommands('PreCompact', matchers, {
        hook_event_name: 'PreCompact',
        trigger: 'manual',
      }),
    ).toEqual([`${SENTINEL}pre-compact`])
    expect(
      await matchedCommands('PreCompact', matchers, {
        hook_event_name: 'PreCompact',
        trigger: 'auto',
      }),
    ).toEqual([])
  })

  test('SessionEnd matches on reason', async () => {
    const matchers = [{ matcher: 'clear', hooks: [cmd('session-end')] }]
    expect(
      await matchedCommands('SessionEnd', matchers, {
        hook_event_name: 'SessionEnd',
        reason: 'clear',
      }),
    ).toEqual([`${SENTINEL}session-end`])
    expect(
      await matchedCommands('SessionEnd', matchers, {
        hook_event_name: 'SessionEnd',
        reason: 'logout',
      }),
    ).toEqual([])
  })

  test('FileChanged matches on the basename, not the full path', async () => {
    const byExtension = [{ matcher: '\\.ts$', hooks: [cmd('ts-file')] }]
    expect(
      await matchedCommands('FileChanged', byExtension, {
        hook_event_name: 'FileChanged',
        file_path: '/repo/src/utils/hooks.ts',
      }),
    ).toEqual([`${SENTINEL}ts-file`])
    expect(
      await matchedCommands('FileChanged', byExtension, {
        hook_event_name: 'FileChanged',
        file_path: '/repo/src/utils/hooks.js',
      }),
    ).toEqual([])

    // The directory portion is discarded before matching.
    const byDirectory = [{ matcher: '^src', hooks: [cmd('src-dir')] }]
    expect(
      await matchedCommands('FileChanged', byDirectory, {
        hook_event_name: 'FileChanged',
        file_path: '/repo/src/utils/hooks.ts',
      }),
    ).toEqual([])
  })

  test('events with no match field ignore the matcher entirely', async () => {
    // TaskCompleted derives no matchQuery, so filtering is skipped and every
    // configured matcher fires — including one that matches no known name.
    const matchers = [{ matcher: 'NoSuchThing', hooks: [cmd('task-done')] }]
    expect(
      await matchedCommands('TaskCompleted', matchers, {
        hook_event_name: 'TaskCompleted',
      }),
    ).toEqual([`${SENTINEL}task-done`])
  })
})

describe('getMatchingHooks matcher matrix — result assembly', () => {
  test('every matching matcher contributes all of its hooks', async () => {
    const matchers = [
      { matcher: '*', hooks: [cmd('a'), cmd('b')] },
      { matcher: 'Bash', hooks: [cmd('c')] },
      { matcher: 'Read', hooks: [cmd('d')] },
    ]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Bash')),
    ).toEqual([`${SENTINEL}a`, `${SENTINEL}b`, `${SENTINEL}c`])
  })

  test('identical commands from different matchers collapse to one', async () => {
    const matchers = [
      { matcher: '*', hooks: [cmd('dup')] },
      { matcher: 'Bash', hooks: [cmd('dup')] },
    ]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Bash')),
    ).toEqual([`${SENTINEL}dup`])
  })

  test('the same command under different shells is not deduplicated', async () => {
    // shell is part of a command hook's identity: the same script run through
    // bash and through powershell are two distinct hooks.
    const matchers = [
      {
        matcher: '*',
        hooks: [
          { type: 'command' as const, command: `${SENTINEL}shells` },
          {
            type: 'command' as const,
            command: `${SENTINEL}shells`,
            shell: 'powershell',
          },
        ],
      },
    ]
    expect(
      await matchedCommands('PreToolUse', matchers, preToolUse('Bash')),
    ).toEqual([`${SENTINEL}shells`, `${SENTINEL}shells`])
  })

  test('session hooks are reported with the settings source', async () => {
    const matched = await getMatchingHooks(
      appStateWith('PreToolUse', [{ matcher: '*', hooks: [cmd('source')] }]),
      SESSION_ID,
      'PreToolUse',
      preToolUse('Bash') as unknown as HookInput,
    )
    const own = matched.filter(m =>
      ((m.hook as { command?: string }).command ?? '').startsWith(SENTINEL),
    )
    expect(own).toHaveLength(1)
    expect(own[0]!.hookSource).toBe('settings')
    expect(own[0]!.pluginRoot).toBeUndefined()
    expect(own[0]!.skillRoot).toBeUndefined()
  })

  test('hooks registered for another session are not returned', async () => {
    const matched = await getMatchingHooks(
      appStateWith('PreToolUse', [{ matcher: '*', hooks: [cmd('other')] }]),
      'a-different-session',
      'PreToolUse',
      preToolUse('Bash') as unknown as HookInput,
    )
    expect(
      matched.filter(m =>
        ((m.hook as { command?: string }).command ?? '').startsWith(SENTINEL),
      ),
    ).toEqual([])
  })

  test('hooks registered for another event are not returned', async () => {
    const matched = await getMatchingHooks(
      appStateWith('PostToolUse', [{ matcher: '*', hooks: [cmd('wrong')] }]),
      SESSION_ID,
      'PreToolUse',
      preToolUse('Bash') as unknown as HookInput,
    )
    expect(
      matched.filter(m =>
        ((m.hook as { command?: string }).command ?? '').startsWith(SENTINEL),
      ),
    ).toEqual([])
  })

  test('an undefined appState yields no session hooks', async () => {
    const matched = await getMatchingHooks(
      undefined,
      SESSION_ID,
      'PreToolUse',
      preToolUse('Bash') as unknown as HookInput,
    )
    expect(
      matched.filter(m =>
        ((m.hook as { command?: string }).command ?? '').startsWith(SENTINEL),
      ),
    ).toEqual([])
  })
})
