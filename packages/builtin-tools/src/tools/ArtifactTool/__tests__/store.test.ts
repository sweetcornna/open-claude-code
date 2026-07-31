import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { workerStore } from '../client.js'
import { rustypasteStore } from '../rustypasteStore.js'
import { getArtifactStore } from '../store.js'

const originalBackend = process.env.OCC_ARTIFACTS_BACKEND

describe('getArtifactStore', () => {
  beforeEach(() => {
    delete process.env.OCC_ARTIFACTS_BACKEND
  })

  afterEach(() => {
    if (originalBackend === undefined) {
      delete process.env.OCC_ARTIFACTS_BACKEND
    } else {
      process.env.OCC_ARTIFACTS_BACKEND = originalBackend
    }
  })

  test('uses the worker store by default', () => {
    expect(getArtifactStore()).toBe(workerStore)
  })

  test('uses the rustypaste store when configured', () => {
    process.env.OCC_ARTIFACTS_BACKEND = 'rustypaste'

    expect(getArtifactStore()).toBe(rustypasteStore)
  })
})
