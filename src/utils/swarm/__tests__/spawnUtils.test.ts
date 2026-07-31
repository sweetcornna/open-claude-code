import { describe, expect, test } from 'bun:test'
import { BIN_NAME } from '../../../constants/brand.js'
import {
  getSwarmSocketName,
  HIDDEN_SESSION_NAME,
  SWARM_SESSION_NAME,
} from '../constants.js'
import { buildInheritedCliFlags } from '../spawnUtils'

describe('swarm runtime identity', () => {
  test('derives tmux names from the product binary name', () => {
    expect(SWARM_SESSION_NAME).toBe(`${BIN_NAME}-swarm`)
    expect(HIDDEN_SESSION_NAME).toBe(`${BIN_NAME}-hidden`)
    expect(getSwarmSocketName()).toBe(`${BIN_NAME}-swarm-${process.pid}`)
  })
})

describe('buildInheritedCliFlags', () => {
  test('propagates auto permission mode to process-based teammates', () => {
    const flags = buildInheritedCliFlags({ permissionMode: 'auto' })

    expect(flags).toContain('--permission-mode auto')
  })
})
