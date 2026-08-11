/**
 * bzip2 decompressor, pure TypeScript, zero dependencies.
 *
 * WHY THIS EXISTS
 *
 * sherpa-onnx — the only upstream that publishes a standalone speech
 * recognition executable for all six platform/arch combinations occ has to
 * support — ships every one of them as `.tar.bz2`. Node covers gzip,
 * deflate and brotli; `fflate` covers zip and gzip; neither covers bzip2.
 *
 * The obvious alternative is `tar -xjf`. That is a coin flip on two of the
 * three target platforms: GNU tar delegates `-j` to a separate `bzip2`
 * binary that minimal Linux images do not install, and whether Microsoft's
 * bundled bsdtar was linked against bz2lib is not something that can be
 * established from a macOS workstation. CLAUDE.md has a standing rule about
 * exactly that failure mode — cross-platform behaviour proven by local
 * experiment is not proven. Four hundred lines of deterministic, fixture-
 * tested decoder is cheaper than a Windows-only bug reported months later.
 *
 * Implements the format as documented in bzip2's own decompress.c and
 * huffman.c: stream header, per-block Huffman-coded MTF/RLE2 symbols,
 * inverse Burrows-Wheeler transform, then RLE1. Randomised blocks
 * (deprecated since bzip2 0.9.5, 1999) are rejected rather than silently
 * mis-decoded.
 */

const BLOCK_MAGIC_HI = 0x314159
const BLOCK_MAGIC_LO = 0x265359
const EOS_MAGIC_HI = 0x177245
const EOS_MAGIC_LO = 0x385090

/** bzip2's BZ_MAX_CODE_LEN. Huffman code lengths never exceed this. */
const MAX_CODE_LEN = 23
/** Symbols are decoded in runs of this length, one Huffman table per run. */
const GROUP_SIZE = 50
const MAX_SELECTORS = 2 + 900000 / GROUP_SIZE

export class Bzip2Error extends Error {
  constructor(message: string) {
    super(`bzip2: ${message}`)
    this.name = 'Bzip2Error'
  }
}

/** MSB-first bit reader over a byte buffer. */
class BitReader {
  private bytePos = 0
  private bitPos = 0

  constructor(private readonly data: Uint8Array) {}

  readBit(): number {
    if (this.bytePos >= this.data.length) {
      throw new Bzip2Error('unexpected end of input')
    }
    const bit = (this.data[this.bytePos]! >> (7 - this.bitPos)) & 1
    this.bitPos++
    if (this.bitPos === 8) {
      this.bitPos = 0
      this.bytePos++
    }
    return bit
  }

  /** Reads up to 24 bits; wider reads would overflow the shift below. */
  readBits(count: number): number {
    let value = 0
    for (let i = 0; i < count; i++) {
      value = (value << 1) | this.readBit()
    }
    return value
  }

  /** Reads 32 bits as an unsigned value (CRCs). */
  readUInt32(): number {
    return this.readBits(16) * 0x10000 + this.readBits(16)
  }
}

type HuffmanTable = {
  limit: Int32Array
  base: Int32Array
  perm: Int32Array
  minLen: number
}

function buildHuffmanTable(
  lengths: Uint8Array,
  alphaSize: number,
): HuffmanTable {
  let minLen = 32
  let maxLen = 0
  for (let i = 0; i < alphaSize; i++) {
    const len = lengths[i]!
    if (len > maxLen) maxLen = len
    if (len < minLen) minLen = len
  }

  const perm = new Int32Array(alphaSize)
  let pp = 0
  for (let len = minLen; len <= maxLen; len++) {
    for (let sym = 0; sym < alphaSize; sym++) {
      if (lengths[sym] === len) perm[pp++] = sym
    }
  }

  const base = new Int32Array(MAX_CODE_LEN + 2)
  for (let i = 0; i < alphaSize; i++) {
    const slot = lengths[i]! + 1
    base[slot] = base[slot]! + 1
  }
  for (let i = 1; i < MAX_CODE_LEN + 2; i++) {
    base[i] = base[i]! + base[i - 1]!
  }

  const limit = new Int32Array(MAX_CODE_LEN + 2)
  let vec = 0
  for (let len = minLen; len <= maxLen; len++) {
    vec += base[len + 1]! - base[len]!
    limit[len] = vec - 1
    vec <<= 1
  }
  for (let len = minLen + 1; len <= maxLen; len++) {
    base[len] = ((limit[len - 1]! + 1) << 1) - base[len]!
  }

  return { limit, base, perm, minLen }
}

function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
  let len = table.minLen
  let code = reader.readBits(len)
  while (len <= MAX_CODE_LEN && code > table.limit[len]!) {
    len++
    code = (code << 1) | reader.readBit()
  }
  if (len > MAX_CODE_LEN) throw new Bzip2Error('invalid Huffman code')
  const index = code - table.base[len]!
  if (index < 0 || index >= table.perm.length) {
    throw new Bzip2Error('Huffman symbol out of range')
  }
  return table.perm[index]!
}

/** Inverse Burrows-Wheeler transform, following bzip2's packed-T layout. */
function inverseBwt(
  bwt: Uint8Array,
  length: number,
  origPtr: number,
): Uint32Array {
  const counts = new Int32Array(256)
  for (let i = 0; i < length; i++) {
    const byte = bwt[i]!
    counts[byte] = counts[byte]! + 1
  }

  // cftab[c] = number of bytes in the block that sort before c.
  const cftab = new Int32Array(257)
  for (let c = 0; c < 256; c++) cftab[c + 1] = cftab[c]! + counts[c]!

  // Low 8 bits hold the byte, high 24 the successor index. nblock never
  // exceeds 900000, so 24 bits is ample.
  const tt = new Uint32Array(length)
  for (let i = 0; i < length; i++) tt[i] = bwt[i]!
  for (let i = 0; i < length; i++) {
    const uc = tt[i]! & 0xff
    const slot = cftab[uc]!
    tt[slot] = tt[slot]! | (i << 8)
    cftab[uc] = slot + 1
  }
  return tt
}

/**
 * Decompress a complete bzip2 stream.
 *
 * Returns the concatenated output of every block. Throws Bzip2Error on any
 * structural problem — callers must treat that as "the download is not
 * usable", never as "extract what we got".
 */
export function bunzip2(input: Uint8Array): Buffer {
  if (
    input.length < 4 ||
    input[0] !== 0x42 || // 'B'
    input[1] !== 0x5a || // 'Z'
    input[2] !== 0x68 // 'h'
  ) {
    throw new Bzip2Error('bad stream header (expected "BZh")')
  }
  const level = input[3]! - 0x30
  if (level < 1 || level > 9) {
    throw new Bzip2Error(`bad block-size level ${level}`)
  }
  const maxBlockSize = level * 100000

  const reader = new BitReader(input.subarray(4))
  const chunks: Buffer[] = []
  const bwt = new Uint8Array(maxBlockSize)
  const mtf = new Uint8Array(256)
  const seqToUnseq = new Uint8Array(256)

  for (;;) {
    const magicHi = reader.readBits(24)
    const magicLo = reader.readBits(24)
    if (magicHi === EOS_MAGIC_HI && magicLo === EOS_MAGIC_LO) {
      reader.readUInt32() // combined stream CRC, not verified
      break
    }
    if (magicHi !== BLOCK_MAGIC_HI || magicLo !== BLOCK_MAGIC_LO) {
      throw new Bzip2Error('bad block magic')
    }

    reader.readUInt32() // per-block CRC, not verified
    if (reader.readBit() !== 0) {
      throw new Bzip2Error(
        'randomised blocks are not supported (deprecated since bzip2 0.9.5)',
      )
    }
    const origPtr = reader.readBits(24)

    // ── Symbol map ────────────────────────────────────────────────
    const usedGroups = reader.readBits(16)
    let symbolCount = 0
    for (let group = 0; group < 16; group++) {
      if ((usedGroups & (0x8000 >> group)) === 0) continue
      const bits = reader.readBits(16)
      for (let bit = 0; bit < 16; bit++) {
        if (bits & (0x8000 >> bit)) {
          seqToUnseq[symbolCount++] = group * 16 + bit
        }
      }
    }
    if (symbolCount === 0) throw new Bzip2Error('empty symbol map')
    const alphaSize = symbolCount + 2
    const eob = alphaSize - 1

    // ── Selectors ─────────────────────────────────────────────────
    const groupCount = reader.readBits(3)
    if (groupCount < 2 || groupCount > 6) {
      throw new Bzip2Error(`bad group count ${groupCount}`)
    }
    const selectorCount = reader.readBits(15)
    if (selectorCount < 1 || selectorCount > MAX_SELECTORS) {
      throw new Bzip2Error(`bad selector count ${selectorCount}`)
    }
    const selectorMtf = new Uint8Array(selectorCount)
    for (let i = 0; i < selectorCount; i++) {
      let j = 0
      while (reader.readBit() === 1) {
        j++
        if (j >= groupCount) throw new Bzip2Error('bad selector')
      }
      selectorMtf[i] = j
    }
    const groupPos = new Uint8Array(groupCount)
    for (let i = 0; i < groupCount; i++) groupPos[i] = i
    const selectors = new Uint8Array(selectorCount)
    for (let i = 0; i < selectorCount; i++) {
      const j = selectorMtf[i]!
      const value = groupPos[j]!
      for (let k = j; k > 0; k--) groupPos[k] = groupPos[k - 1]!
      groupPos[0] = value
      selectors[i] = value
    }

    // ── Huffman tables ────────────────────────────────────────────
    const tables: HuffmanTable[] = []
    for (let g = 0; g < groupCount; g++) {
      const lengths = new Uint8Array(alphaSize)
      let current = reader.readBits(5)
      for (let sym = 0; sym < alphaSize; sym++) {
        for (;;) {
          if (current < 1 || current > 20) {
            throw new Bzip2Error('bad code length')
          }
          if (reader.readBit() === 0) break
          current += reader.readBit() === 0 ? 1 : -1
        }
        lengths[sym] = current
      }
      tables.push(buildHuffmanTable(lengths, alphaSize))
    }

    // ── MTF + RLE2 decode into the BWT block ──────────────────────
    for (let i = 0; i < symbolCount; i++) mtf[i] = i
    let blockLength = 0
    let groupIndex = -1
    let groupRemaining = 0
    let table = tables[0]!
    let runLength = 0
    let runBit = 0

    const nextSymbol = (): number => {
      if (groupRemaining === 0) {
        groupIndex++
        if (groupIndex >= selectorCount) {
          throw new Bzip2Error('ran out of selectors')
        }
        groupRemaining = GROUP_SIZE
        table = tables[selectors[groupIndex]!]!
      }
      groupRemaining--
      return decodeSymbol(reader, table)
    }

    const flushRun = (): void => {
      if (runLength === 0) return
      if (blockLength + runLength > maxBlockSize) {
        throw new Bzip2Error('block overflow')
      }
      const byte = seqToUnseq[mtf[0]!]!
      bwt.fill(byte, blockLength, blockLength + runLength)
      blockLength += runLength
      runLength = 0
      runBit = 0
    }

    let symbol = nextSymbol()
    while (symbol !== eob) {
      if (symbol === 0 || symbol === 1) {
        // RUNA/RUNB encode the run length in bijective base 2.
        if (runBit > 24) throw new Bzip2Error('run length overflow')
        runLength += (symbol + 1) << runBit
        runBit++
        symbol = nextSymbol()
        continue
      }
      flushRun()
      const mtfIndex = symbol - 1
      if (mtfIndex >= symbolCount) throw new Bzip2Error('MTF index overflow')
      const value = mtf[mtfIndex]!
      for (let k = mtfIndex; k > 0; k--) mtf[k] = mtf[k - 1]!
      mtf[0] = value
      if (blockLength >= maxBlockSize) throw new Bzip2Error('block overflow')
      bwt[blockLength++] = seqToUnseq[value]!
      symbol = nextSymbol()
    }
    flushRun()

    if (origPtr >= blockLength) throw new Bzip2Error('origPtr out of range')

    // ── Inverse BWT + RLE1 ────────────────────────────────────────
    const tt = inverseBwt(bwt, blockLength, origPtr)
    // Worst case RLE1 expands 5 bytes to 255; real payloads sit near 1:1,
    // so grow on demand instead of allocating 51x up front.
    let out = Buffer.allocUnsafe(blockLength + (blockLength >> 1) + 256)
    let outLength = 0
    const ensure = (extra: number): void => {
      if (outLength + extra <= out.length) return
      const grown = Buffer.allocUnsafe(
        Math.max(out.length * 2, outLength + extra),
      )
      out.copy(grown, 0, 0, outLength)
      out = grown
    }

    let tPos = tt[origPtr]! >>> 8
    let remaining = blockLength
    let previous = -1
    let repeat = 0
    const nextByte = (): number => {
      tPos = tt[tPos]!
      const byte = tPos & 0xff
      tPos >>>= 8
      remaining--
      return byte
    }

    while (remaining > 0) {
      const byte = nextByte()
      if (repeat === 4) {
        // The byte after four identical bytes is a repeat count.
        if (byte > 0) {
          ensure(byte)
          out.fill(previous, outLength, outLength + byte)
          outLength += byte
        }
        previous = -1
        repeat = 0
        continue
      }
      repeat = byte === previous ? repeat + 1 : 1
      previous = byte
      ensure(1)
      out[outLength++] = byte
    }

    chunks.push(out.subarray(0, outLength))
  }

  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)
}
