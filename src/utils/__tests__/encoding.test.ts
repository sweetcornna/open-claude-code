import { describe, test, expect } from 'bun:test'
import {
  detectEncoding,
  decodeBuffer,
  encodeString,
  type FileEncoding,
  type DetectedEncoding,
} from '../encoding'

describe('detectEncoding', () => {
  test('detects UTF-16LE BOM', () => {
    const buf = Buffer.from([0xff, 0xfe, 0x48, 0x00])
    expect(detectEncoding(buf)).toBe('utf-16le')
  })

  test('detects UTF-8 BOM', () => {
    const buf = Buffer.from([0xef, 0xbb, 0xbf, 0x48, 0x65])
    expect(detectEncoding(buf)).toBe('utf-8')
  })

  test('detects valid UTF-8 without BOM', () => {
    const buf = Buffer.from('Hello, 世界', 'utf-8')
    expect(detectEncoding(buf)).toBe('utf-8')
  })

  test('detects GBK encoded Chinese text', () => {
    // "你好" in GBK: C4 E3 BA C3
    const buf = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
    expect(detectEncoding(buf)).toBe('gbk')
  })

  test('returns utf-8 for empty buffer', () => {
    const buf = Buffer.alloc(0)
    expect(detectEncoding(buf)).toBe('utf-8')
  })

  test('falls back to latin1 for random bytes', () => {
    // Random bytes that aren't valid UTF-8 or GBK
    const buf = Buffer.from([0x80, 0x81, 0x82, 0x83, 0x84, 0x85])
    expect(detectEncoding(buf)).toBe('latin1')
  })

  test('prioritizes BOM over content analysis', () => {
    // UTF-8 BOM followed by bytes that could be confused
    const buf = Buffer.from([0xef, 0xbb, 0xbf, 0x48, 0x65, 0x6c, 0x6c, 0x6f])
    expect(detectEncoding(buf)).toBe('utf-8')
  })
})

describe('decodeBuffer', () => {
  test('decodes UTF-8 buffer correctly', () => {
    const buf = Buffer.from('Hello, 世界', 'utf-8')
    expect(decodeBuffer(buf, 'utf-8')).toBe('Hello, 世界')
  })

  test('decodes GBK buffer correctly', () => {
    // "你好" in GBK
    const buf = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
    expect(decodeBuffer(buf, 'gbk')).toBe('你好')
  })

  test('decodes UTF-16LE buffer correctly', () => {
    const buf = Buffer.from([
      0x48, 0x00, 0x65, 0x00, 0x6c, 0x00, 0x6c, 0x00, 0x6f, 0x00,
    ])
    expect(decodeBuffer(buf, 'utf-16le')).toBe('Hello')
  })

  test('decodes empty buffer', () => {
    const buf = Buffer.alloc(0)
    expect(decodeBuffer(buf, 'utf-8')).toBe('')
  })

  test('decodes latin1 using strict ISO-8859-1 mapping', () => {
    // 0x80 should decode to U+0080 (control char), NOT € (U+20AC)
    const buf = Buffer.from([0x80, 0x85, 0x9c, 0xa0, 0xff])
    const decoded = decodeBuffer(buf, 'latin1')
    expect(decoded.charCodeAt(0)).toBe(0x80)
    expect(decoded.charCodeAt(1)).toBe(0x85)
    expect(decoded.charCodeAt(2)).toBe(0x9c)
    expect(decoded.charCodeAt(3)).toBe(0xa0)
    expect(decoded.charCodeAt(4)).toBe(0xff)
  })
})

describe('encodeString', () => {
  test('encodes UTF-8 string without conversion flag', () => {
    const { buffer, converted } = encodeString('Hello 世界', 'utf-8')
    expect(converted).toBe(false)
    expect(buffer.toString('utf-8')).toBe('Hello 世界')
  })

  test('encodes UTF-8 with utf8 alias', () => {
    const { buffer, converted } = encodeString('test', 'utf8')
    expect(converted).toBe(false)
    expect(buffer.toString('utf-8')).toBe('test')
  })

  test('encodes UTF-16LE string', () => {
    const { buffer, converted } = encodeString('Hello', 'utf-16le')
    expect(converted).toBe(false)
    expect(decodeBuffer(buffer, 'utf-16le')).toBe('Hello')
  })

  test('encodes GBK string correctly', () => {
    const { buffer, converted } = encodeString('你好', 'gbk')
    expect(converted).toBe(false)
    expect(buffer.toString('hex')).toBe('c4e3bac3')
  })

  test('GBK round-trip preserves bytes', () => {
    // "测试文件" in GBK
    const original = Buffer.from([
      0xb2, 0xe2, 0xca, 0xd4, 0xce, 0xc4, 0xbc, 0xfe,
    ])
    const decoded = decodeBuffer(original, 'gbk')
    const { buffer } = encodeString(decoded, 'gbk')
    expect(buffer.equals(original)).toBe(true)
  })

  test('GBK encoding handles mixed ASCII and CJK', () => {
    // "Hello你好" in GBK: 48 65 6c 6c 6f c4 e3 ba c3
    const { buffer, converted } = encodeString('Hello你好', 'gbk')
    expect(converted).toBe(false)
    expect(buffer.toString('hex')).toBe('48656c6c6fc4e3bac3')
  })

  test('latin1 round-trip preserves all byte values', () => {
    // Test the full 0x80-0xFF range that previously broke
    const bytes = Buffer.from([
      0x80, 0x81, 0x85, 0x8c, 0x9c, 0xa0, 0xc0, 0xe9, 0xf6, 0xfc, 0xff,
    ])
    const decoded = decodeBuffer(bytes, 'latin1')
    const { buffer } = encodeString(decoded, 'latin1')
    expect(buffer.equals(bytes)).toBe(true)
  })

  test('latin1 encoding does not set converted flag', () => {
    const { buffer, converted } = encodeString('test\x80\x90', 'latin1')
    expect(converted).toBe(false)
    expect(buffer.toString('hex')).toBe('746573748090')
  })
})

describe('round-trip consistency', () => {
  test('GBK file survives full read-decode-encode cycle', () => {
    const original = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0d, 0x0a])
    const enc = detectEncoding(original)
    expect(enc).toBe('gbk')
    const decoded = decodeBuffer(original, enc)
    const { buffer } = encodeString(decoded, enc)
    expect(buffer.equals(original)).toBe(true)
  })

  test('latin1 file survives full read-decode-encode cycle', () => {
    const original = Buffer.from([0x80, 0x90, 0xa0, 0xff, 0x41, 0x42])
    const enc = detectEncoding(original)
    expect(enc).toBe('latin1')
    const decoded = decodeBuffer(original, enc)
    const { buffer } = encodeString(decoded, enc)
    expect(buffer.equals(original)).toBe(true)
  })

  test('UTF-8 file survives full read-decode-encode cycle', () => {
    const original = Buffer.from('Hello 世界', 'utf-8')
    const enc = detectEncoding(original)
    expect(enc).toBe('utf-8')
    const decoded = decodeBuffer(original, enc)
    const { buffer } = encodeString(decoded, enc)
    expect(buffer.equals(original)).toBe(true)
  })
})
