/**
 * DeepSeek tuning gate + request-shaping tests.
 *
 * The invariant these protect: every DeepSeek-specific behaviour is opt-in by
 * model/endpoint, and a non-DeepSeek OpenAI-compatible endpoint (GLM, Kimi,
 * Qwen, local vLLM) produces exactly the request body it did before.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'

import { logMock } from '../../../../tests/mocks/log.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

import {
  buildDeepSeekThinkingFields,
  capDeepSeekTools,
  DEEPSEEK_CODING_TEMPERATURE,
  DEEPSEEK_MAX_TOOLS,
  isDeepSeekBaseURL,
  isDeepSeekFamilyModel,
  isDeepSeekTuningActiveForModel,
  resolveDeepSeekReasoningEffort,
  resolveDeepSeekTemperature,
} from '../deepseekTuning.js'
import { buildOpenAIRequestBody } from '../../../services/api/openai/requestBody.js'

const ORIGINAL_TEMPERATURE_ENV = process.env.DEEPSEEK_TEMPERATURE

afterEach(() => {
  if (ORIGINAL_TEMPERATURE_ENV === undefined) {
    delete process.env.DEEPSEEK_TEMPERATURE
  } else {
    process.env.DEEPSEEK_TEMPERATURE = ORIGINAL_TEMPERATURE_ENV
  }
})

describe('model detection', () => {
  test('matches hosted and self-hosted DeepSeek ids', () => {
    for (const id of [
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-ai/DeepSeek-V4-Pro',
    ]) {
      expect(isDeepSeekFamilyModel(id), id).toBe(true)
    }
  })

  test('does not match other models behind the OpenAI-compatible layer', () => {
    for (const id of [
      'gpt-5.6',
      'glm-4.7',
      'kimi-k2',
      'qwen3-coder',
      'mimo-7b',
    ]) {
      expect(isDeepSeekFamilyModel(id), id).toBe(false)
    }
  })

  test('recognises the official endpoint so proxy model aliases still tune', () => {
    expect(isDeepSeekBaseURL('https://api.deepseek.com')).toBe(true)
    expect(isDeepSeekBaseURL('https://api.deepseek.com/v1')).toBe(true)
    expect(isDeepSeekBaseURL('https://open.bigmodel.cn/api/paas/v4')).toBe(
      false,
    )
    expect(isDeepSeekBaseURL(undefined)).toBe(false)
    // Malformed URLs must not throw inside request construction.
    expect(isDeepSeekBaseURL('not a url')).toBe(false)
  })

  test('either signal activates the gate', () => {
    expect(
      isDeepSeekTuningActiveForModel('default', 'https://api.deepseek.com'),
    ).toBe(true)
    expect(
      isDeepSeekTuningActiveForModel(
        'deepseek-chat',
        'https://proxy.internal/v1',
      ),
    ).toBe(true)
    expect(
      isDeepSeekTuningActiveForModel('glm-4.7', 'https://proxy.internal/v1'),
    ).toBe(false)
  })
})

describe('resolveDeepSeekTemperature', () => {
  test('defaults to the documented coding value', () => {
    delete process.env.DEEPSEEK_TEMPERATURE
    expect(resolveDeepSeekTemperature({ enableThinking: false })).toBe(
      DEEPSEEK_CODING_TEMPERATURE,
    )
  })

  test('omits temperature entirely in thinking mode', () => {
    // DeepSeek: "Thinking mode does not support the temperature, top_p,
    // presence_penalty, or frequency_penalty parameters."
    expect(
      resolveDeepSeekTemperature({
        enableThinking: true,
        explicitOverride: 0.7,
      }),
    ).toBeUndefined()
  })

  test('an explicit caller override wins over the default', () => {
    expect(
      resolveDeepSeekTemperature({
        enableThinking: false,
        explicitOverride: 0.7,
      }),
    ).toBe(0.7)
  })

  test('DEEPSEEK_TEMPERATURE opts out without giving up the rest of the tuning', () => {
    process.env.DEEPSEEK_TEMPERATURE = '1.3'
    expect(resolveDeepSeekTemperature({ enableThinking: false })).toBe(1.3)
  })

  test('ignores unparseable or out-of-range env values rather than forwarding them', () => {
    for (const bad of ['abc', '-1', '2.5', '']) {
      process.env.DEEPSEEK_TEMPERATURE = bad
      expect(resolveDeepSeekTemperature({ enableThinking: false }), bad).toBe(
        DEEPSEEK_CODING_TEMPERATURE,
      )
    }
  })
})

describe('capDeepSeekTools', () => {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `t${i}` }))

  test('passes through a list at or under the API limit', () => {
    const tools = make(DEEPSEEK_MAX_TOOLS)
    const result = capDeepSeekTools(tools)
    expect(result.dropped).toBe(0)
    expect(result.tools).toBe(tools)
  })

  test('truncates the tail, keeping the core tools that come first', () => {
    const result = capDeepSeekTools(make(DEEPSEEK_MAX_TOOLS + 5))
    expect(result.tools).toHaveLength(DEEPSEEK_MAX_TOOLS)
    expect(result.dropped).toBe(5)
    expect(result.tools[0]).toEqual({ name: 't0' })
  })
})

describe('resolveDeepSeekReasoningEffort', () => {
  test("collapses occ's five rungs onto DeepSeek's three", () => {
    expect(resolveDeepSeekReasoningEffort('low')).toBe('low')
    // medium → high, not low: sending nothing already meant `high`, so any
    // other mapping would silently change behaviour at occ's default effort.
    expect(resolveDeepSeekReasoningEffort('medium')).toBe('high')
    expect(resolveDeepSeekReasoningEffort('high')).toBe('high')
    expect(resolveDeepSeekReasoningEffort('xhigh')).toBe('max')
    expect(resolveDeepSeekReasoningEffort('max')).toBe('max')
  })

  test('falls through to the provider default rather than inventing a rung', () => {
    expect(resolveDeepSeekReasoningEffort(undefined)).toBeUndefined()
    expect(resolveDeepSeekReasoningEffort(64)).toBeUndefined()
    expect(resolveDeepSeekReasoningEffort('minimal')).toBeUndefined()
  })
})

describe('buildDeepSeekThinkingFields', () => {
  test('sends only the documented field on the official endpoint', () => {
    expect(
      buildDeepSeekThinkingFields({
        enableThinking: true,
        baseURL: 'https://api.deepseek.com',
      }),
    ).toEqual({ thinking: { type: 'enabled' } })
  })

  test('adds the self-hosted spellings off-endpoint', () => {
    expect(
      buildDeepSeekThinkingFields({
        enableThinking: true,
        baseURL: 'https://vllm.internal/v1',
      }),
    ).toEqual({
      thinking: { type: 'enabled' },
      enable_thinking: true,
      chat_template_kwargs: { thinking: true, enable_thinking: true },
    })
  })

  test('says "disabled" out loud — DeepSeek defaults to enabled', () => {
    expect(
      buildDeepSeekThinkingFields({
        enableThinking: false,
        baseURL: 'https://api.deepseek.com',
      }),
    ).toEqual({ thinking: { type: 'disabled' } })
  })
})

describe('buildOpenAIRequestBody — DeepSeek isolation', () => {
  const base = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [] as unknown[],
    toolChoice: undefined,
    maxTokens: 1024,
  } as never as Parameters<typeof buildOpenAIRequestBody>[0]

  test('caps the tool list for DeepSeek only', () => {
    const tools = Array.from({ length: DEEPSEEK_MAX_TOOLS + 3 }, (_, i) => ({
      type: 'function',
      function: { name: `t${i}` },
    }))

    const deepseek = buildOpenAIRequestBody({
      ...base,
      model: 'deepseek-v4-pro',
      enableThinking: false,
      tools,
    })
    expect(deepseek.tools).toHaveLength(DEEPSEEK_MAX_TOOLS)

    const other = buildOpenAIRequestBody({
      ...base,
      model: 'glm-4.7',
      enableThinking: false,
      tools,
    })
    expect(other.tools).toHaveLength(DEEPSEEK_MAX_TOOLS + 3)
  })

  test('thinking mode still sends no temperature', () => {
    const body = buildOpenAIRequestBody({
      ...base,
      model: 'deepseek-v4-pro',
      enableThinking: true,
    })
    expect(body.temperature).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'enabled' })
  })

  test('forwards the mapped reasoning_effort for DeepSeek only', () => {
    const deepseek = buildOpenAIRequestBody({
      ...base,
      model: 'deepseek-v4-pro',
      enableThinking: true,
      effortValue: 'xhigh',
    })
    expect(deepseek.reasoning_effort).toBe('max')

    // The same effort must not leak onto an unrelated compatible endpoint —
    // reasoning_effort is an unknown top-level key to most of them.
    const other = buildOpenAIRequestBody({
      ...base,
      model: 'glm-4.7',
      enableThinking: true,
      effortValue: 'xhigh',
    })
    expect(other.reasoning_effort).toBeUndefined()
  })

  test('omits reasoning_effort when thinking is off — it steers nothing', () => {
    const body = buildOpenAIRequestBody({
      ...base,
      model: 'deepseek-v4-pro',
      enableThinking: false,
      effortValue: 'max',
    })
    expect(body.reasoning_effort).toBeUndefined()
  })

  test('an explicit OpenAI reasoningEffort still wins on non-DeepSeek models', () => {
    const body = buildOpenAIRequestBody({
      ...base,
      model: 'gpt-5.6',
      enableThinking: false,
      reasoningEffort: 'medium',
    })
    expect(body.reasoning_effort).toBe('medium')
  })
})
