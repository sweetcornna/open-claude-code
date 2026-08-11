/**
 * Digest verification for downloaded local-STT artifacts.
 *
 * Zero-dependency leaf: only `node:crypto`. Everything this backend writes
 * to disk — the sherpa-onnx wheel, every model file — goes through
 * `verifyDigest` first, against a value pinned in catalog.ts that was read
 * from a metadata API rather than from the bytes themselves.
 */

import { createHash } from 'node:crypto'
import type { ArtifactDigest } from './catalog.js'

/**
 * Git's object id for a blob: SHA-1 over the header `blob <size>\0`
 * followed by the content. Hugging Face exposes this (and only this) for
 * files that are not Git-LFS backed, which is how the small `tokens.txt`
 * vocabularies are stored.
 */
export function gitBlobSha1(data: Uint8Array): string {
  const hash = createHash('sha1')
  hash.update(`blob ${data.byteLength}\0`)
  hash.update(data)
  return hash.digest('hex')
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function computeDigest(
  data: Uint8Array,
  algorithm: ArtifactDigest['algorithm'],
): string {
  return algorithm === 'sha256' ? sha256Hex(data) : gitBlobSha1(data)
}

export class DigestMismatchError extends Error {
  constructor(
    readonly label: string,
    readonly expected: ArtifactDigest,
    readonly actual: string,
  ) {
    super(
      `${label}: ${expected.algorithm} mismatch — expected ${expected.value}, got ${actual}. ` +
        'The download was discarded; nothing was executed.',
    )
    this.name = 'DigestMismatchError'
  }
}

/**
 * Throws DigestMismatchError unless `data` matches. Callers must not write
 * the bytes anywhere durable before this returns.
 */
export function verifyDigest(
  label: string,
  data: Uint8Array,
  expected: ArtifactDigest,
): void {
  const actual = computeDigest(data, expected.algorithm)
  if (actual !== expected.value) {
    throw new DigestMismatchError(label, expected, actual)
  }
}
