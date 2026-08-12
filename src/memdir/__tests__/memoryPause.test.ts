/**
 * `/pause-memory` session state and command.
 *
 * No module mocks: the pause switch is a zero-dependency module and the command
 * module only touches it plus the (no-op) analytics sink.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  isMemoryPaused,
  resetMemoryPausedForTesting,
  setMemoryPaused,
  toggleMemoryPaused,
} from '../memoryPause.js'
import pauseMemoryCommand from '../../commands/pause-memory/index.js'

afterEach(resetMemoryPausedForTesting)

describe('memory pause state', () => {
  test('starts resumed', () => {
    expect(isMemoryPaused()).toBe(false)
  })

  test('toggles both ways and reports the new state', () => {
    expect(toggleMemoryPaused()).toBe(true)
    expect(isMemoryPaused()).toBe(true)
    expect(toggleMemoryPaused()).toBe(false)
    expect(isMemoryPaused()).toBe(false)
  })

  test('can be set explicitly', () => {
    setMemoryPaused(true)
    expect(isMemoryPaused()).toBe(true)
  })
})

describe('/pause-memory command', () => {
  test('registers the documented name and aliases', () => {
    expect(pauseMemoryCommand.name).toBe('pause-memory')
    expect(pauseMemoryCommand.aliases).toEqual([
      'memory-pause',
      'toggle-memory',
    ])
    expect(pauseMemoryCommand.type).toBe('local')
    expect(pauseMemoryCommand.supportsNonInteractive).toBe(true)
  })

  test('pauses on first run and resumes on the second', async () => {
    const { call } = await pauseMemoryCommand.load()

    const paused = await call()
    expect(isMemoryPaused()).toBe(true)
    expect(paused.type).toBe('text')
    expect(paused.type === 'text' && paused.value).toContain('Memory paused')

    const resumed = await call()
    expect(isMemoryPaused()).toBe(false)
    expect(resumed.type === 'text' && resumed.value).toContain('Memory resumed')
  })
})
