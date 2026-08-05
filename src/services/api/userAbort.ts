import { APIUserAbortError } from '@anthropic-ai/sdk'

/**
 * Did this failure come from the user interrupting, rather than from anything
 * going wrong?
 *
 * A user interrupt is a completed action, not a fault: they pressed Esc and got
 * what they asked for. Surfacing it as `API Error: <abort wording>` in the
 * transcript is pure noise — it reads like a failure the user should look into,
 * it lands in the conversation history the model later reads back, and the
 * exact wording is decided by whichever layer happened to abort first (undici,
 * the SDK, a DOMException), so it isn't even stable.
 *
 * The first-party path already handles this: `claude.ts` returns without
 * yielding on `APIUserAbortError`, and `query.ts` renders the interrupt. The
 * third-party adapters had no such check — their single catch-all turned every
 * failure into an error message — which is why interrupting an OpenAI/Gemini/
 * Grok turn produced a red "API Error: ... aborted" line.
 *
 * `signal` is checked in addition to the error shape because the wrapper layers
 * do not preserve `name === 'AbortError'` reliably; if the caller's signal is
 * aborted, whatever surfaced is a consequence of that.
 */
export function isUserAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true
  }
  if (error instanceof APIUserAbortError) {
    return true
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return true
  }
  return false
}
