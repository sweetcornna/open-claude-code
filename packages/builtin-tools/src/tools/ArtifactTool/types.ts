/**
 * Backend contract, in a leaf module.
 *
 * `store.ts` re-exports all three names, so nothing outside this directory has
 * to know they moved. New backends should import from here rather than from
 * `store.ts`: `store.ts` imports every backend, so a type import pointing back
 * at it closes an import cycle (`check:cycles` counts type edges too).
 */

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
