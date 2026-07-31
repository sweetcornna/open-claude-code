import { workerStore } from './client.js'
import { getArtifactsBackend } from './config.js'
import { rustypasteStore } from './rustypasteStore.js'

export type ArtifactUploadInput = {
  html: string
  hash?: string
  ttlDays: 7 | 30
}

export type ArtifactUploadResult = {
  id: string
  url: string
  expiresAt?: string
}

export interface ArtifactStore {
  upload(input: ArtifactUploadInput): Promise<ArtifactUploadResult>
}

export function getArtifactStore(): ArtifactStore {
  return getArtifactsBackend() === 'rustypaste' ? rustypasteStore : workerStore
}
