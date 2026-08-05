import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  type BootstrapStateHost,
  registerBootstrapStateHost,
} from '@open-claude-code/tool-runtime/bootstrapState.js'
import * as realState from 'src/bootstrap/state.js'

// enabled.ts reads session state through the tool-runtime bootstrapState
// facade (a static edge to src/bootstrap/state.js closed a dependency cycle —
// see the comment at the top of enabled.ts). So this suite registers a facade
// host rather than mocking the host module: no mock.module at all, and the test
// exercises the same indirection production uses.
//
// Getters close over mutable locals because the facade resolves at call time.
let interactive = true
let sdkSummaries = false

// Only these two getters are reachable from enabled.ts. The facade throws on
// anything unregistered, so an accidental new dependency surfaces loudly rather
// than as a silent default.
const testHost = {
  getIsNonInteractiveSession: () => !interactive,
  getSdkAgentProgressSummariesEnabled: () => sdkSummaries,
} as BootstrapStateHost

const {
  areAgentSummariesAllowed,
  isBackgroundAgentSummarizationEnabled,
  isForegroundAgentSummarizationEnabled,
} = await import('../enabled.js')

beforeEach(() => {
  interactive = true
  sdkSummaries = false
  delete process.env.OCC_AGENT_SUMMARIES
  // The facade host is a process-global singleton and src/bootstrap/state.ts
  // registers the real one as an import side-effect. Re-register per test so
  // this suite wins no matter which file loaded first.
  registerBootstrapStateHost(testHost)
})

afterEach(() => {
  delete process.env.OCC_AGENT_SUMMARIES
})

afterAll(() => {
  // Hand the facade back to the real host so later files in this process see
  // production behaviour instead of this suite's two-method stub.
  registerBootstrapStateHost(realState as unknown as BootstrapStateHost)
})

describe('areAgentSummariesAllowed', () => {
  test('defaults to on', () => {
    expect(areAgentSummariesAllowed()).toBe(true)
  })

  test.each([
    '0',
    'false',
    'no',
    'off',
    'FALSE',
  ])('OCC_AGENT_SUMMARIES=%s turns it off', value => {
    process.env.OCC_AGENT_SUMMARIES = value
    expect(areAgentSummariesAllowed()).toBe(false)
  })

  test.each([
    '1',
    'true',
    'on',
  ])('OCC_AGENT_SUMMARIES=%s keeps it on', value => {
    process.env.OCC_AGENT_SUMMARIES = value
    expect(areAgentSummariesAllowed()).toBe(true)
  })

  test('an empty value is not a disable', () => {
    // Shell users hit `OCC_AGENT_SUMMARIES=` by accident; treat it as unset
    // rather than as an opt-out that silently kills the feature.
    process.env.OCC_AGENT_SUMMARIES = ''
    expect(areAgentSummariesAllowed()).toBe(true)
  })
})

describe('isBackgroundAgentSummarizationEnabled', () => {
  // The whole point of this work line: a background agent in a normal
  // interactive session summarizes without any flag being set.
  test('an interactive TUI session enables it with no flags', () => {
    expect(isBackgroundAgentSummarizationEnabled()).toBe(true)
  })

  test('OCC_AGENT_SUMMARIES=0 disables it', () => {
    process.env.OCC_AGENT_SUMMARIES = '0'
    expect(isBackgroundAgentSummarizationEnabled()).toBe(false)
  })

  test('a non-interactive session stays opt-in', () => {
    interactive = false
    expect(isBackgroundAgentSummarizationEnabled()).toBe(false)
  })

  test('the SDK control request opts a non-interactive session in', () => {
    interactive = false
    sdkSummaries = true
    expect(isBackgroundAgentSummarizationEnabled()).toBe(true)
  })

  test('an explicit opt-in (coordinator / fork subagent) works headless', () => {
    interactive = false
    expect(isBackgroundAgentSummarizationEnabled(true)).toBe(true)
  })

  test.each([
    ['explicit opt-in', () => isBackgroundAgentSummarizationEnabled(true)],
    [
      'SDK control request',
      () => {
        sdkSummaries = true
        return isBackgroundAgentSummarizationEnabled()
      },
    ],
  ])('OCC_AGENT_SUMMARIES=0 outranks the %s', (_label, run) => {
    // The env var is set by whoever runs the process; an "off" that still
    // billed forks would be the surprising reading.
    interactive = false
    process.env.OCC_AGENT_SUMMARIES = '0'
    expect(run()).toBe(false)
  })
})

describe('isForegroundAgentSummarizationEnabled', () => {
  // Foreground agents have isBackgrounded === false, which every recap surface
  // filters out (useBackgroundAgentTasks / isBackgroundTask). Summarizing them
  // would be a fork every 30s with nowhere to render.
  test('an interactive TUI session does NOT enable it', () => {
    expect(interactive).toBe(true)
    expect(isForegroundAgentSummarizationEnabled()).toBe(false)
  })

  test('it stays available to SDK consumers that opted in', () => {
    sdkSummaries = true
    expect(isForegroundAgentSummarizationEnabled()).toBe(true)
  })

  test('OCC_AGENT_SUMMARIES=0 is a global kill switch here too', () => {
    sdkSummaries = true
    process.env.OCC_AGENT_SUMMARIES = '0'
    expect(isForegroundAgentSummarizationEnabled()).toBe(false)
  })

  test('coordinator-style opt-in does not leak into the foreground path', () => {
    // isBackgroundAgentSummarizationEnabled takes an explicitOptIn argument;
    // the foreground predicate deliberately has no such escape hatch.
    expect(isBackgroundAgentSummarizationEnabled(true)).toBe(true)
    expect(isForegroundAgentSummarizationEnabled()).toBe(false)
  })
})
