/**
 * `tryReadImageFromPath` must never reject.
 *
 * usePasteHandler fans it out through `Promise.all`, so a single rejection
 * used to take down the whole batch, escape an uncaught `.then()`, and strand
 * the prompt on "Pasting text…" with Enter swallowed. Decode/resize failures
 * are now contained: one bad image degrades to `null`, and the caller falls
 * back to a plain text paste.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { tryReadImageFromPath } = await import('../imagePaste.js')

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'occ-imagepaste-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A PNG signature + IHDR declaring 100000x100000 and nothing else. Whichever
 * way the resizer fails on it — Sharp refusing to decode, the resize call
 * throwing, or the image processor being unavailable — it lands in
 * maybeResizeAndDownsampleImageBuffer's catch, where the over-dimension check
 * turns it into a thrown ImageResizeError. That throw is exactly the one that
 * used to wedge the prompt.
 */
function oversizedFakePng(): Buffer {
  const buf = Buffer.alloc(32)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(100_000, 16)
  buf.writeUInt32BE(100_000, 20)
  return buf
}

describe('tryReadImageFromPath', () => {
  test('returns null instead of rejecting when the resizer throws', async () => {
    const path = join(dir, 'oversized.png')
    writeFileSync(path, oversizedFakePng())

    // The assertion that matters is "resolves", not "is null" — a rejection
    // here is what the paste wedge was made of.
    await expect(tryReadImageFromPath(path)).resolves.toBeNull()
  })

  test('returns null for an empty image file', async () => {
    const path = join(dir, 'empty.png')
    writeFileSync(path, Buffer.alloc(0))

    await expect(tryReadImageFromPath(path)).resolves.toBeNull()
  })

  test('returns null for a missing file', async () => {
    await expect(
      tryReadImageFromPath(join(dir, 'does-not-exist.png')),
    ).resolves.toBeNull()
  })

  test('returns null for text that is not an image path at all', async () => {
    await expect(tryReadImageFromPath('just some words')).resolves.toBeNull()
  })
})
