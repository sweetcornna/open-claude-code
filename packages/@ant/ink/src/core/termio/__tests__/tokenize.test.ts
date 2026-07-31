import { describe, expect, test } from 'bun:test'
import { createTokenizer, type Token } from '../tokenize.js'

const ESC = '\x1b'

/** Feed every chunk, then flush, and return the full token stream. */
function tokenizeAll(...chunks: string[]): Token[] {
  const tokenizer = createTokenizer()
  const tokens: Token[] = []
  for (const chunk of chunks) {
    tokens.push(...tokenizer.feed(chunk))
  }
  tokens.push(...tokenizer.flush())

  return tokens
}

function textValues(tokens: Token[]): string[] {
  return tokens.filter(t => t.type === 'text').map(t => t.value)
}

describe('tokenize malformed escape sequences', () => {
  test('does not leak the ESC byte from an invalid CSI into text', () => {
    const tokens = tokenizeAll(`${ESC}[\x01`)

    for (const value of textValues(tokens)) {
      expect(value).not.toContain(ESC)
    }
    expect(textValues(tokens).join('')).toBe('[\x01')
  })

  test('does not leak the ESC byte from an invalid two-byte escape', () => {
    const tokens = tokenizeAll(`${ESC}\x01`)

    for (const value of textValues(tokens)) {
      expect(value).not.toContain(ESC)
    }
    expect(textValues(tokens).join('')).toBe('\x01')
  })

  test('does not leak the ESC byte from an invalid SS3 sequence', () => {
    const tokens = tokenizeAll(`${ESC}O\x01`)

    for (const value of textValues(tokens)) {
      expect(value).not.toContain(ESC)
    }
    expect(textValues(tokens).join('')).toBe('O\x01')
  })

  test('does not leak the ESC byte from an invalid intermediate escape', () => {
    const tokens = tokenizeAll(`${ESC}(\x01`)

    for (const value of textValues(tokens)) {
      expect(value).not.toContain(ESC)
    }
    expect(textValues(tokens).join('')).toBe('(\x01')
  })

  test('preserves the text surrounding a malformed sequence', () => {
    const tokens = tokenizeAll(`ab${ESC}[\x01cd`)

    for (const value of textValues(tokens)) {
      expect(value).not.toContain(ESC)
    }
    expect(textValues(tokens)).toEqual(['ab', '[\x01cd'])
  })

  test('does not leak ESC when the malformed sequence spans two feeds', () => {
    const tokens = tokenizeAll(ESC, '\x01')

    for (const value of textValues(tokens)) {
      expect(value).not.toContain(ESC)
    }
    expect(textValues(tokens).join('')).toBe('\x01')
  })

  test('emits a lone ESC as a sequence, never as text', () => {
    const tokens = tokenizeAll(ESC)

    expect(textValues(tokens)).toEqual([])
    expect(tokens).toEqual([{ type: 'sequence', value: ESC }])
  })
})

describe('tokenize valid sequences', () => {
  test('still emits a complete CSI sequence', () => {
    expect(tokenizeAll(`${ESC}[31m`)).toEqual([
      { type: 'sequence', value: `${ESC}[31m` },
    ])
  })

  test('still splits text around a complete CSI sequence', () => {
    expect(tokenizeAll(`hi${ESC}[Athere`)).toEqual([
      { type: 'text', value: 'hi' },
      { type: 'sequence', value: `${ESC}[A` },
      { type: 'text', value: 'there' },
    ])
  })

  test('still emits a complete SS3 sequence', () => {
    expect(tokenizeAll(`${ESC}OP`)).toEqual([
      { type: 'sequence', value: `${ESC}OP` },
    ])
  })

  test('still emits a complete OSC sequence', () => {
    expect(tokenizeAll(`${ESC}]0;title\x07`)).toEqual([
      { type: 'sequence', value: `${ESC}]0;title\x07` },
    ])
  })

  test('still emits a two-character escape sequence', () => {
    expect(tokenizeAll(`${ESC}b`)).toEqual([
      { type: 'sequence', value: `${ESC}b` },
    ])
  })

  test('still joins a sequence split across two feeds', () => {
    expect(tokenizeAll(`${ESC}[`, '31m')).toEqual([
      { type: 'sequence', value: `${ESC}[31m` },
    ])
  })
})
