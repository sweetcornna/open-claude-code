import { mock } from 'bun:test'
import * as realConfig from '../../packages/remote-control-server/src/config.js'

type RcsConfig = typeof realConfig.config

const baselineConfig: RcsConfig = { ...realConfig.config }
const config: RcsConfig = { ...baselineConfig }

const configMockFactory = () => ({
  config,
  getBaseUrl: () => {
    const url = config.baseUrl || `http://localhost:${config.port}`
    return url.replace(/\/+$/, '')
  },
})

let installed = false

export function setupRcsConfigMock(): {
  set(overrides: Partial<RcsConfig>): void
  reset(): void
} {
  if (!installed) {
    mock.module(
      '../../packages/remote-control-server/src/config.ts',
      configMockFactory,
    )
    installed = true
  }

  return {
    set: overrides => {
      Object.assign(config, baselineConfig, overrides)
    },
    reset: () => {
      Object.assign(config, baselineConfig)
    },
  }
}
