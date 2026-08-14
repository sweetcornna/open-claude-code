import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { workerStore } from '../client.js'
import { localStore } from '../localStore.js'
import { rustypasteStore } from '../rustypasteStore.js'
import { getArtifactStore } from '../store.js'
import { getArtifactsBackend } from '../config.js'

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

  test('uses the local store by default (nothing leaves the machine)', () => {
    expect(getArtifactsBackend()).toBe('local')
    expect(getArtifactStore()).toBe(localStore)
  })

  test('uses the worker store only when explicitly selected', () => {
    process.env.OCC_ARTIFACTS_BACKEND = 'worker'

    expect(getArtifactStore()).toBe(workerStore)
  })

  test('uses the rustypaste store when configured', () => {
    process.env.OCC_ARTIFACTS_BACKEND = 'rustypaste'

    expect(getArtifactStore()).toBe(rustypasteStore)
  })

  test('rejects an unknown backend name', () => {
    process.env.OCC_ARTIFACTS_BACKEND = 'gist'

    expect(() => getArtifactStore()).toThrow(/Unsupported artifact backend/)
  })
})
