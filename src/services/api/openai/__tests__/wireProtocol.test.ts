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

  test('Codex-family models default to responses', () => {
    delete process.env.OPENAI_WIRE_API
    delete process.env.OPENAI_AUTH_MODE
    expect(resolveOpenAIWireProtocol('gpt-5.3-codex')).toBe('responses')
    expect(resolveOpenAIWireProtocol('codex-mini-latest')).toBe('responses')
    expect(resolveOpenAIWireProtocol('gpt-5.6-sol')).toBe('responses')
    expect(resolveOpenAIWireProtocol('gpt-5.4-mini')).toBe('responses')
    expect(resolveOpenAIWireProtocol('gpt-5')).toBe('responses')
  })

  test('non-Codex models keep the chat default', () => {
    delete process.env.OPENAI_WIRE_API
    delete process.env.OPENAI_AUTH_MODE
    expect(resolveOpenAIWireProtocol('gpt-4o')).toBe('chat')
    expect(resolveOpenAIWireProtocol('gpt-4.1')).toBe('chat')
    expect(resolveOpenAIWireProtocol('deepseek-chat')).toBe('chat')
    expect(resolveOpenAIWireProtocol('gpt-55')).toBe('chat')
  })

  test('explicit OPENAI_WIRE_API=chat wins over the Codex-family default', () => {
    process.env.OPENAI_WIRE_API = 'chat'
    delete process.env.OPENAI_AUTH_MODE
    expect(resolveOpenAIWireProtocol('gpt-5.3-codex')).toBe('chat')
  })

  test('omitting the model keeps the legacy resolution (backward compat)', () => {
    delete process.env.OPENAI_WIRE_API
    delete process.env.OPENAI_AUTH_MODE
    expect(resolveOpenAIWireProtocol()).toBe('chat')
  })
})
