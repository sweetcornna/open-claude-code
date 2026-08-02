/**
 * Re-export barrel for the read-file-state cache.
 *
 * The implementation now lives in
 * `@open-claude-code/tool-runtime/fileStateCache.js` (wave C2 of the
 * tool-runtime dependency inversion — see that file's header for why the
 * class had to move rather than be mirrored). This file stays behind so the
 * existing host importers, and `mock.module('src/utils/fileStateCache.js')`
 * in tests, keep resolving unchanged.
 */

export type { FileState } from '@open-claude-code/tool-runtime/fileStateCache.js'

export {
  cacheKeys,
  cacheToObject,
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  FileStateCache,
  mergeFileStateCaches,
  READ_FILE_STATE_CACHE_SIZE,
} from '@open-claude-code/tool-runtime/fileStateCache.js'
