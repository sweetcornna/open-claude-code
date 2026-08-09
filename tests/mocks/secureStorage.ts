/**
 * Shared in-memory mock for `src/utils/secureStorage/index.js`. Use it via:
 *
 *   import { secureStorageMock } from '../../tests/mocks/secureStorage'
 *
 *   mock.module('src/utils/secureStorage/index.ts', secureStorageMock.mock)
 *   beforeEach(() => secureStorageMock.reset())
 *
 * Any test that exercises credential storage has to substitute the real thing:
 * on macOS it shells out to the login keychain, everywhere else it reads and
 * writes `~/.occ/.credentials.json`. Either way an unmocked test would touch
 * the developer's own credentials and behave differently per platform.
 *
 * There is deliberately ONE store rather than a per-file factory. `mock.module`
 * is process-global and last-write-wins, so two files each registering their
 * own store would depend on Bun re-binding an already-imported module for their
 * assertions to read the store their own code just wrote — and would silently
 * assert against each other's if it ever stopped. Sharing one store makes the
 * ordering irrelevant; `reset()` provides the isolation instead.
 *
 * `seed()` / `snapshot()` expose the backing object so a test can arrange a
 * pre-migration store and assert on what was persisted, without going through
 * the storage interface.
 */

type StorageData = Record<string, unknown>

let data: StorageData | null = null
let writeCount = 0
let deleteCount = 0
let updateResult: { success: boolean; warning?: string } = { success: true }
let deleteResult = true

// Mirrors `plainTextStorage`'s surface exactly — production code type-checks
// against `SecureStorage`, which is `any` in this codebase, so a missing method
// would only surface as a runtime failure in some unrelated test.
const storage = {
  name: 'in-memory-test',
  read: () => data,
  readAsync: async () => data,
  update: (next: StorageData) => {
    if (updateResult.success) {
      data = structuredClone(next)
      writeCount++
    }
    return { ...updateResult }
  },
  delete: () => {
    deleteCount++
    if (deleteResult) data = null
    return deleteResult
  },
}

export const secureStorageMock = {
  /** Pass to `mock.module('src/utils/secureStorage/index.ts', …)`. */
  mock: () => ({ getSecureStorage: () => storage }),
  /** Replace the stored blob wholesale. */
  seed: (next: StorageData | null) => {
    data = next ? structuredClone(next) : null
  },
  /** The stored blob as it currently stands (a deep copy). */
  snapshot: (): StorageData | null => (data ? structuredClone(data) : null),
  /** Successful writes so far — for asserting a migration wrote exactly once. */
  writes: () => writeCount,
  /** Delete attempts so far. */
  deletes: () => deleteCount,
  /** Set the result returned by future update attempts. */
  setUpdateResult: (result: { success: boolean; warning?: string }) => {
    updateResult = { ...result }
  },
  /** Set the result returned by future delete attempts. */
  setDeleteResult: (result: boolean) => {
    deleteResult = result
  },
  /** Drop everything. Call from `beforeEach`. */
  reset: () => {
    data = null
    writeCount = 0
    deleteCount = 0
    updateResult = { success: true }
    deleteResult = true
  },
}
