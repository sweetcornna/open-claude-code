/**
 * Encoding detection and conversion utilities for file I/O.
 *
 * Provides three-layer encoding detection (BOM → UTF-8 fatal → GBK fallback)
 * and Buffer/string conversion functions. Zero external dependencies — uses only
 * TextDecoder/TextEncoder APIs available in Bun/Node.js.
 */

/** Extended encoding type covering non-UTF-8 encodings used in CJK files */
export type FileEncoding = BufferEncoding | 'gbk'

/** Encoding name accepted by TextDecoder (string), broader than FileEncoding */
export type DetectedEncoding = string

// ---------------------------------------------------------------------------
// GBK encode table — built once at module load via TextDecoder reverse lookup.
// Maps Unicode codepoint → [leadByte, trailByte] for every valid 2-byte GBK
// sequence. Single-byte ASCII (0x00-0x7F) needs no entry; those pass through
// Buffer.from directly.
// ---------------------------------------------------------------------------

const gbkEncodeMap = new Map<number, [number, number]>()
let gbkTableBuilt = false

/**
 * Build the GBK encode map by iterating every valid 2-byte GBK sequence
 * (lead 0x81-0xFE, trail 0x40-0xFE excluding 0x7F) and recording the
 * resulting Unicode codepoint from TextDecoder.
 */
function ensureGbkTable(): void {
  if (gbkTableBuilt) return
  gbkTableBuilt = true

  const decoder = new TextDecoder('gbk', { fatal: true })
  const twoByteBuf = Buffer.alloc(2)

  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue
      twoByteBuf[0] = lead
      twoByteBuf[1] = trail
      try {
        const str = decoder.decode(twoByteBuf)
        const cp = str.charCodeAt(0)
        if (cp > 0x7f) {
          gbkEncodeMap.set(cp, [lead, trail])
        }
      } catch {
        // Invalid GBK sequence — skip
      }
    }
  }
}

/**
 * Encode a string to GBK bytes. ASCII chars (U+0000-U+007F) are copied as-is;
 * CJK chars are looked up in the prebuilt table. Unencodable chars become '?'.
 */
function encodeGbk(str: string): Buffer {
  ensureGbkTable()

  // Pre-allocate: worst case is 2 bytes per char
  const parts: Buffer[] = []
  let asciiRun = ''

  for (let i = 0; i < str.length; i++) {
    const cp = str.charCodeAt(i)

    if (cp <= 0x7f) {
      asciiRun += str[i]
      continue
    }

    // Flush ASCII run
    if (asciiRun.length > 0) {
      parts.push(Buffer.from(asciiRun, 'ascii'))
      asciiRun = ''
    }

    const pair = gbkEncodeMap.get(cp)
    if (pair) {
      parts.push(Buffer.from(pair))
    } else {
      // Unencodable char — use '?' as fallback
      parts.push(Buffer.from([0x3f]))
    }
  }

  // Flush remaining ASCII
  if (asciiRun.length > 0) {
    parts.push(Buffer.from(asciiRun, 'ascii'))
  }

  return Buffer.concat(parts)
}

/**
 * Detect the encoding of a buffer using three-layer detection:
 * 1. BOM (Byte Order Mark) detection
 * 2. UTF-8 fatal validation
 * 3. GBK fallback (most common non-UTF-8 CJK encoding)
 */
export function detectEncoding(buffer: Buffer): FileEncoding {
  // Layer 1: BOM detection
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return 'utf-16le'
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return 'utf-8'
  }

  // Layer 2: UTF-8 fatal validation
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return 'utf-8'
  } catch {
    // Not valid UTF-8, proceed to Layer 3
  }

  // Layer 3: GBK fallback
  try {
    new TextDecoder('gbk', { fatal: true }).decode(buffer)
    return 'gbk'
  } catch {
    // Not valid GBK, fall back to latin1 (single-byte, always succeeds)
    return 'latin1'
  }
}

/**
 * Decode a buffer using the specified encoding.
 * Unified decoding entry point for all file read paths.
 *
 * For 'latin1', uses strict ISO-8859-1 mapping (byte N → U+00N) instead of
 * TextDecoder('latin1'), because Bun's TextDecoder treats 'latin1' as
 * Windows-1252 in the 0x80-0x9F range, which breaks round-trip through
 * Buffer.from(str, 'latin1').
 */
export function decodeBuffer(
  buffer: Buffer,
  encoding: DetectedEncoding,
): string {
  if (encoding === 'latin1') {
    // Strict ISO-8859-1: byte value = Unicode codepoint.
    // This guarantees round-trip fidelity with Buffer.from(str, 'latin1').
    let result = ''
    for (let i = 0; i < buffer.length; i++) {
      result += String.fromCharCode(buffer[i])
    }
    return result
  }
  return new TextDecoder(encoding).decode(buffer)
}

/**
 * Encode a string to a Buffer using the specified encoding.
 * For non-standard encodings, falls back to UTF-8 if the runtime
 * doesn't support the encoding in Buffer.from.
 *
 * @returns buffer - the encoded bytes, converted - true if encoding was
 *   fallbacked to UTF-8 (caller should warn the user)
 */
export function encodeString(
  content: string,
  encoding: DetectedEncoding,
): { buffer: Buffer; converted: boolean } {
  if (encoding === 'utf-8' || encoding === 'utf8') {
    return { buffer: Buffer.from(content, 'utf-8'), converted: false }
  }
  if (encoding === 'utf-16le') {
    return { buffer: Buffer.from(content, 'utf-16le'), converted: false }
  }
  if (encoding === 'gbk') {
    return { buffer: encodeGbk(content), converted: false }
  }
  // Buffer-supported encodings (latin1, ascii, binary, etc.)
  try {
    const buf = Buffer.from(content, encoding as BufferEncoding)
    return { buffer: buf, converted: false }
  } catch {
    return { buffer: Buffer.from(content, 'utf-8'), converted: true }
  }
}
