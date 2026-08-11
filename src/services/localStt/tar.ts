/**
 * Minimal tar reader, pure TypeScript, zero dependencies.
 *
 * Paired with bzip2.ts so the local-STT install needs no `tar` binary on
 * any platform. Handles what GNU tar actually emits for the sherpa-onnx
 * release archives: ustar regular files and directories, the `prefix`
 * field, GNU long names (typeflag 'L') and pax extended headers
 * (typeflag 'x'/'g', `path=` records). Symlinks and hard links are
 * surfaced so the caller can materialise them as copies — creating real
 * symlinks needs Developer Mode or an elevated process on Windows, which
 * is not something a voice feature may demand.
 */

const BLOCK_SIZE = 512

export class TarError extends Error {
  constructor(message: string) {
    super(`tar: ${message}`)
    this.name = 'TarError'
  }
}

export type TarEntry = {
  /** Path with forward slashes, as stored in the archive. */
  name: string
  type: 'file' | 'directory' | 'symlink' | 'hardlink'
  /** Unix mode bits from the header (0 when absent). */
  mode: number
  /** File contents. Empty for non-regular entries. */
  data: Uint8Array
  /** Target for symlink/hardlink entries, forward slashes. */
  linkTarget: string
}

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset
  const limit = offset + length
  while (end < limit && block[end] !== 0) end++
  return Buffer.from(block.subarray(offset, end)).toString('utf8')
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  // GNU base-256 encoding for values that do not fit in the octal field.
  // The sherpa archives never need it (no file is 8GB), but a silent
  // misparse here would truncate a payload, so handle it rather than
  // guess.
  if ((block[offset]! & 0x80) !== 0) {
    let value = block[offset]! & 0x7f
    for (let i = offset + 1; i < offset + length; i++) {
      value = value * 256 + block[i]!
    }
    return value
  }
  const text = readString(block, offset, length).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false
  }
  return true
}

function parsePaxPath(data: Uint8Array): string | null {
  // Records are "<len> <key>=<value>\n"; only `path` matters here.
  const text = Buffer.from(data).toString('utf8')
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)
  return match ? match[1]! : null
}

/**
 * Parse an uncompressed tar archive.
 *
 * Entries are returned in archive order. Throws TarError on a malformed
 * header — a partially-parsed archive must never be treated as a
 * successful extraction.
 */
export function readTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  let pendingLongName: string | null = null
  let pendingPaxPath: string | null = null

  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE)
    if (isZeroBlock(header)) break
    offset += BLOCK_SIZE

    const size = readOctal(header, 124, 12)
    const typeFlag = String.fromCharCode(header[156]!)
    const dataStart = offset
    const dataEnd = dataStart + size
    if (dataEnd > archive.length) {
      throw new TarError('entry extends past end of archive')
    }
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE

    if (typeFlag === 'L') {
      pendingLongName = readString(archive, dataStart, size).replace(/\0+$/, '')
      continue
    }
    if (typeFlag === 'x' || typeFlag === 'g') {
      pendingPaxPath = parsePaxPath(archive.subarray(dataStart, dataEnd))
      continue
    }
    if (typeFlag === 'K') {
      // GNU long link target — not needed, and skipping it would attach
      // the wrong target to the next entry, so drop the entry instead.
      pendingLongName = null
      pendingPaxPath = null
      continue
    }

    const prefix = readString(header, 345, 155)
    const rawName = readString(header, 0, 100)
    const name =
      pendingPaxPath ??
      pendingLongName ??
      (prefix ? `${prefix}/${rawName}` : rawName)
    pendingLongName = null
    pendingPaxPath = null

    let type: TarEntry['type']
    if (typeFlag === '5') type = 'directory'
    else if (typeFlag === '2') type = 'symlink'
    else if (typeFlag === '1') type = 'hardlink'
    else if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '7')
      type = 'file'
    else continue // character/block devices, FIFOs: nothing to install

    entries.push({
      name: name.replace(/\/+$/, ''),
      type,
      mode: readOctal(header, 100, 8) & 0o7777,
      data: type === 'file' ? archive.subarray(dataStart, dataEnd) : EMPTY,
      linkTarget: readString(header, 157, 100),
    })
  }

  return entries
}

const EMPTY = new Uint8Array(0)
