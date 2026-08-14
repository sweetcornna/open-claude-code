import { workerStore } from './client.js'
import { getArtifactsBackend } from './config.js'
import { localStore } from './localStore.js'
import { rustypasteStore } from './rustypasteStore.js'
import type { ArtifactStore } from './types.js'

export type {
  ArtifactStore,
  ArtifactUploadInput,
  ArtifactUploadResult,
} from './types.js'

export function getArtifactStore(): ArtifactStore {
  switch (getArtifactsBackend()) {
    case 'worker':
      return workerStore
    case 'rustypaste':
      return rustypasteStore
    default:
      return localStore
  }
}
