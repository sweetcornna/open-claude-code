/**
 * Shared in-memory mock for `src/utils/secureStorage/index.js`. Use it via:
 *
 *   import { setupSecureStorageMock } from '../../tests/mocks/secureStorage'
 *
 *   const secureStorage = setupSecureStorageMock()
 *   mock.module('src/utils/secureStorage/index.ts', secureStorage.mock)
 *
 * Any test that exercises credential storage has to substitute the real thing:
 * on macOS it shells out to the login keychain, everywhere else it reads and
 * writes `~/.occ/.credentials.json`. Either way an unmocked test would touch
 * the developer's own credentials and behave differently per platform.
 *
 * `seed()` / `snapshot()` expose the backing object so a test can arrange a
 * pre-migration store and assert on what was persisted, without reaching
 * through the storage interface.
 */

type StorageData = Record<string, unknown>

export type SecureStorageMockHandle = {
  /** Pass to `mock.module('src/utils/secureStorage/index.ts', …)`. */
  mock: () => { getSecureStorage: () => unknown }
  /** Replace the stored blob wholesale. */
  seed: (data: StorageData | null) => void
  /** The stored blob as it currently stands (a deep copy). */
  snapshot: () => StorageData | null
  /** Number of successful writes, for asserting a migration wrote exactly once. */
  writes: () => number
  /** Reset to empty. */
  reset: () => void
}

export function setupSecureStorageMock(
  initial: StorageData | null = null,
): SecureStorageMockHandle {
  let data: StorageData | null = initial ? structuredClone(initial) : null
  let writes = 0

  // Mirrors `plainTextStorage`'s surface exactly — production code type-checks
  // against `SecureStorage`, which is `any` in this codebase, so a missing
  // method would only show up as a runtime failure in an unrelated test.
  const storage = {
    name: 'in-memory-test',
    read: () => data,
    readAsync: async () => data,
    update: (next: StorageData) => {
      data = structuredClone(next)
      writes++
      return { success: true }
    },
    delete: () => {
      data = null
      return true
    },
  }

  return {
    mock: () => ({ getSecureStorage: () => storage }),
    seed: next => {
      data = next ? structuredClone(next) : null
    },
    snapshot: () => (data ? structuredClone(data) : null),
    writes: () => writes,
    reset: () => {
      data = null
      writes = 0
    },
  }
}
