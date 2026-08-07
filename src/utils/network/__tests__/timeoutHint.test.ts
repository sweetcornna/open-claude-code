import { describe, expect, test } from 'bun:test'
import { getTimeoutHintEnvVar } from '../timeoutHint.js'

describe('getTimeoutHintEnvVar', () => {
  test('says nothing for connection drops — the case that started this', () => {
    // The reported screenshot: `API Error: terminated` carrying
    // "API_TIMEOUT_MS=600000ms, try increasing it". Raising the deadline does
    // not keep a socket from being torn down.
    for (const text of [
      'terminated',
      'API Error: terminated',
      'TypeError: fetch failed',
      'socket hang up',
      'ECONNRESET',
      'other side closed',
      'Connection error.',
    ]) {
      expect(getTimeoutHintEnvVar(text)).toBeNull()
    }
  })

  test('points at API_TIMEOUT_MS for request-deadline failures', () => {
    for (const text of [
      'Request timed out.',
      'request timeout',
      'connect ETIMEDOUT 1.2.3.4:443',
      'ESOCKETTIMEDOUT',
      'ERR_SOCKET_CONNECTION_TIMEOUT',
      'ECONNABORTED',
    ]) {
      expect(getTimeoutHintEnvVar(text)).toBe('API_TIMEOUT_MS')
    }
  })

  test('points at the idle watchdog variable, not the request deadline', () => {
    // 90s idle is what actually catches a stalled stream; API_TIMEOUT_MS is
    // 600s and would never be the thing that fired.
    //
    // These two strings are the ones claude.ts actually throws (:2483 and
    // :2512). Note they are NOT the watchdog's debug-log wording ("Streaming
    // idle timeout: no chunks received for 90s") — that line only logs, and
    // matching it here would have tested a string no user ever sees.
    expect(
      getTimeoutHintEnvVar('Stream idle timeout - no chunks received'),
    ).toBe('CLAUDE_STREAM_IDLE_TIMEOUT_MS')
    expect(
      getTimeoutHintEnvVar('Stream ended without receiving any events'),
    ).toBe('CLAUDE_STREAM_IDLE_TIMEOUT_MS')
  })

  test('says nothing for undici transport limits — no setting reaches them', () => {
    expect(
      getTimeoutHintEnvVar('UND_ERR_BODY_TIMEOUT: Body Timeout Error'),
    ).toBeNull()
    expect(getTimeoutHintEnvVar('Headers Timeout Error')).toBeNull()
  })

  test('is case-insensitive and tolerates surrounding text', () => {
    expect(
      getTimeoutHintEnvVar('APIConnectionTimeoutError: Request timed out.'),
    ).toBe('API_TIMEOUT_MS')
  })
})
