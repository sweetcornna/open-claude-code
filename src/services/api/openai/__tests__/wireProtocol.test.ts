import { afterEach, describe, expect, test } from 'bun:test'
import { resolveOpenAIWireProtocol } from '../wireProtocol.js'

describe('resolveOpenAIWireProtocol', () => {
  const savedEnv = {
    OPENAI_WIRE_API: process.env.OPENAI_WIRE_API,
    OPENAI_AUTH_MODE: process.env.OPENAI_AUTH_MODE,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('defaults to chat', () => {
    delete process.env.OPENAI_WIRE_API
    delete process.env.OPENAI_AUTH_MODE
    expect(resolveOpenAIWireProtocol()).toBe('chat')
  })

  test('OPENAI_WIRE_API=responses selects the Responses protocol', () => {
    process.env.OPENAI_WIRE_API = 'responses'
    delete process.env.OPENAI_AUTH_MODE
    expect(resolveOpenAIWireProtocol()).toBe('responses')
  })

  test('ChatGPT auth forces responses', () => {
    delete process.env.OPENAI_WIRE_API
    process.env.OPENAI_AUTH_MODE = 'chatgpt'
    expect(resolveOpenAIWireProtocol()).toBe('responses')
  })

  test('explicit OPENAI_WIRE_API=chat wins over ChatGPT auth', () => {
    process.env.OPENAI_WIRE_API = 'chat'
    process.env.OPENAI_AUTH_MODE = 'chatgpt'
    expect(resolveOpenAIWireProtocol()).toBe('chat')
  })

  test('unknown values fall back to the default resolution', () => {
    process.env.OPENAI_WIRE_API = 'grpc'
    delete process.env.OPENAI_AUTH_MODE
    expect(resolveOpenAIWireProtocol()).toBe('chat')
  })
})
