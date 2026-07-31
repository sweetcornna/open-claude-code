import type { Meter, MetricOptions } from '@opentelemetry/api'
import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { type AttributedCounter, STATE } from './container.js'

export function getStatsStore(): {
  observe(name: string, value: number): void
} | null {
  return STATE.statsStore
}

export function setStatsStore(
  store: { observe(name: string, value: number): void } | null,
): void {
  STATE.statsStore = store
}

export function setMeter(
  meter: Meter,
  createCounter: (name: string, options: MetricOptions) => AttributedCounter,
): void {
  STATE.meter = meter

  // Initialize all counters using the provided factory
  STATE.sessionCounter = createCounter('claude_code.session.count', {
    description: 'Count of CLI sessions started',
  })
  STATE.locCounter = createCounter('claude_code.lines_of_code.count', {
    description:
      "Count of lines of code modified, with the 'type' attribute indicating whether lines were added or removed",
  })
  STATE.prCounter = createCounter('claude_code.pull_request.count', {
    description: 'Number of pull requests created',
  })
  STATE.commitCounter = createCounter('claude_code.commit.count', {
    description: 'Number of git commits created',
  })
  STATE.costCounter = createCounter('claude_code.cost.usage', {
    description: 'Cost of the Claude Code session',
    unit: 'USD',
  })
  STATE.tokenCounter = createCounter('claude_code.token.usage', {
    description: 'Number of tokens used',
    unit: 'tokens',
  })
  STATE.codeEditToolDecisionCounter = createCounter(
    'claude_code.code_edit_tool.decision',
    {
      description:
        'Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools',
    },
  )
  STATE.activeTimeCounter = createCounter('claude_code.active_time.total', {
    description: 'Total active time in seconds',
    unit: 's',
  })
}

export function getMeter(): Meter | null {
  return STATE.meter
}

export function getSessionCounter(): AttributedCounter | null {
  return STATE.sessionCounter
}

export function getLocCounter(): AttributedCounter | null {
  return STATE.locCounter
}

export function getPrCounter(): AttributedCounter | null {
  return STATE.prCounter
}

export function getCommitCounter(): AttributedCounter | null {
  return STATE.commitCounter
}

export function getCostCounter(): AttributedCounter | null {
  return STATE.costCounter
}

export function getTokenCounter(): AttributedCounter | null {
  return STATE.tokenCounter
}

export function getCodeEditToolDecisionCounter(): AttributedCounter | null {
  return STATE.codeEditToolDecisionCounter
}

export function getActiveTimeCounter(): AttributedCounter | null {
  return STATE.activeTimeCounter
}

export function getLoggerProvider(): LoggerProvider | null {
  return STATE.loggerProvider
}

export function setLoggerProvider(provider: LoggerProvider | null): void {
  STATE.loggerProvider = provider
}

export function getEventLogger(): ReturnType<typeof logs.getLogger> | null {
  return STATE.eventLogger
}

export function setEventLogger(
  logger: ReturnType<typeof logs.getLogger> | null,
): void {
  STATE.eventLogger = logger
}

export function getMeterProvider(): MeterProvider | null {
  return STATE.meterProvider
}

export function setMeterProvider(provider: MeterProvider | null): void {
  STATE.meterProvider = provider
}
export function getTracerProvider(): BasicTracerProvider | null {
  return STATE.tracerProvider
}
export function setTracerProvider(provider: BasicTracerProvider | null): void {
  STATE.tracerProvider = provider
}
