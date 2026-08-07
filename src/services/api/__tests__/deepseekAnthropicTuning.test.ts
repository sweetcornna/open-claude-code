import { afterEach, describe, expect, test } from 'bun:test'
import {
  isDeepSeekTuningActiveForModel,
  resolveDeepSeekTemperature,
} from '../../../utils/model/deepseekTuning.js'

/**
 * DeepSeek now reaches occ through its Anthropic-compatible endpoint
 * (deepseekWire.ts), so the tuning that used to live only on the OpenAI chat
 * path has to be reachable from the Anthropic request builder too.
 *
 * These pin the gate and the temperature rule. The two behaviours in
 * claude.ts that consume them were verified against the live endpoint on
 * 2026-08-07:
 *
 *   no `thinking` field      → content ['thinking','text']  (still thinking!)
 *   `{type:'disabled'}`      → content ['text']
 *   `temperature: 0`         → accepted
 *   150 tools                → accepted (so the chat-line 128 cap does NOT
 *                              apply here and must not be ported)
 */

afterEach(() => {
  delete process.env.DEEPSEEK_TEMPERATURE
})

describe('gate on the Anthropic path', () => {
  test('matches on the model id', () => {
    expect(isDeepSeekTuningActiveForModel('deepseek-v4-pro', undefined)).toBe(
      true,
    )
  })

  test('matches on the base URL alone', () => {
    // Essential here: DeepSeek's Anthropic line also answers to `claude-*`
    // names and maps them to v4-pro / v4-flash server-side, so a session that
    // never renamed its tiers sends a Claude id to a DeepSeek endpoint.
    expect(
      isDeepSeekTuningActiveForModel(
        'claude-opus-5',
        'https://api.deepseek.com/anthropic',
      ),
    ).toBe(true)
  })

  test('does not match an unrelated endpoint', () => {
    expect(
      isDeepSeekTuningActiveForModel(
        'claude-opus-5',
        'https://api.anthropic.com',
      ),
    ).toBe(false)
    expect(
      isDeepSeekTuningActiveForModel(
        'glm-5.2',
        'https://ark.cn-beijing.volces.com/api/coding/v3',
      ),
    ).toBe(false)
  })
})

describe('temperature rule', () => {
  test('0 for coding when thinking is off', () => {
    // DeepSeek's implicit default is 1.0; its own parameter guide puts code
    // and maths at 0.0.
    expect(resolveDeepSeekTemperature({ enableThinking: false })).toBe(0)
  })

  test('nothing is sent while thinking is on', () => {
    expect(resolveDeepSeekTemperature({ enableThinking: true })).toBeUndefined()
  })

  test('an explicit override wins', () => {
    expect(
      resolveDeepSeekTemperature({
        enableThinking: false,
        explicitOverride: 0.7,
      }),
    ).toBe(0.7)
  })

  test('DEEPSEEK_TEMPERATURE opts out per-session', () => {
    process.env.DEEPSEEK_TEMPERATURE = '0.3'
    expect(resolveDeepSeekTemperature({ enableThinking: false })).toBe(0.3)
  })
})
