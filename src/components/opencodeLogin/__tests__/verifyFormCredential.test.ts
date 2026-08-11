/**
 * The API-key half of "a login that cannot be used must configure nothing".
 *
 * The Console flow's guard (activateSession.test.ts) covers the device code.
 * This covers the other credential kind, where the hole is identical and for
 * the same structural reason: OpenCode's step 1 asks only `GET /models`, both
 * products answer that with no credential at all, so a wrong key produces a
 * full picker of real ids, a complete save, and a REPL whose every prompt comes
 * back `API Error [OpenAI]: Invalid API key`.
 *
 * The probe is a parameter, so every case below runs against an injected fake.
 * That is not a convenience: a WRONG key is the one input that cannot be handed
 * to the live service on a user's behalf, and the interesting behaviour here is
 * all in how a refusal is classified and explained. Each test asserts on the
 * arguments the fake actually received, so an injection that silently failed to
 * take effect fails the test rather than passing it.
 *
 * Only the log/debug leaves are mock.module'd, per CLAUDE.md.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const ZEN = 'https://opencode.ai/zen/v1'
const GO = 'https://opencode.ai/zen/go/v1'

let verify: typeof import('../verifyFormCredential.js')
let catalog: typeof import('../opencodeCatalog.js')

beforeAll(async () => {
  verify = await import('../verifyFormCredential.js')
  catalog = await import('../opencodeCatalog.js')
})

type ProbeCall = {
  token: string
  kind: string
  baseUrl: string
  model: string
  signal: AbortSignal | undefined
}

/** A stand-in for `verifyOpencodeAccess` that records what it was asked. */
function fakeProbe(answer: { ok: true } | { ok: false; reason: string }): {
  probe: typeof import('src/services/auth/opencode/index.js').verifyOpencodeAccess
  calls: ProbeCall[]
} {
  const calls: ProbeCall[] = []
  return {
    calls,
    probe: async (credential, baseUrl, model, signal) => {
      calls.push({
        token: credential.token,
        kind: credential.kind,
        baseUrl,
        model,
        signal,
      })
      return answer
    },
  }
}

describe('a key the endpoint refuses', () => {
  test('refuses, and never on the strength of a public /models answer', async () => {
    const { probe, calls } = fakeProbe({
      ok: false,
      reason: 'Invalid API key.',
    })
    const result = await verify.verifyOpencodeFormCredential(
      {
        baseURL: GO,
        apiKey: 'sk-wrong',
        // A full, real catalog — exactly what a wrong key gets back today,
        // because /models needs no credential.
        models: [{ id: 'kimi-k3' }, { id: 'glm-5.2' }],
      },
      probe,
    )

    // The injection took effect: a probe that was never called would leave this
    // empty and the assertions below would be measuring nothing.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.token).toBe('sk-wrong')
    expect(calls[0]?.kind).toBe('key')
    expect(calls[0]?.baseUrl).toBe(GO)
    // Named from the catalog the endpoint itself answered with.
    expect(calls[0]?.model).toBe('kimi-k3')
    expect(result.ok).toBe(false)
  })

  test('names the product, the URL, the other product, and the way out', async () => {
    const { probe } = fakeProbe({ ok: false, reason: 'Invalid API key.' })
    const result = await verify.verifyOpencodeFormCredential(
      { baseURL: GO, apiKey: 'sk-wrong', models: [{ id: 'kimi-k3' }] },
      probe,
    )
    if (result.ok) throw new Error('expected a refusal')

    // "Invalid API key." on its own names nothing actionable: the two products
    // are one path segment apart on one host and are billed separately.
    expect(result.message).toContain('OpenCode Go')
    expect(result.message).toContain(GO)
    expect(result.message).toContain('Invalid API key.')
    expect(result.message).toContain('OpenCode Zen')
    expect(result.message).toContain(ZEN)
    expect(result.message).toContain('Nothing was configured')
    // Both exits: correct the key here, or use the other credential kind.
    // No keystroke is named — the two hosts of this wizard recover differently.
    expect(result.message).toContain('try again')
    expect(result.message).toContain('Console')
  })

  test('the key itself is never quoted back', async () => {
    const { probe } = fakeProbe({ ok: false, reason: 'Invalid API key.' })
    const result = await verify.verifyOpencodeFormCredential(
      { baseURL: ZEN, apiKey: 'sk-secret-value', models: [{ id: 'kimi-k3' }] },
      probe,
    )
    if (result.ok) throw new Error('expected a refusal')
    expect(result.message).not.toContain('sk-secret-value')
  })

  test('an unrecognised endpoint is not called by a product name', async () => {
    // occ describes the two endpoints it has read. A self-hosted gateway is
    // neither, so there is no other product to point at either.
    const { probe } = fakeProbe({ ok: false, reason: 'Invalid API key.' })
    const result = await verify.verifyOpencodeFormCredential(
      { baseURL: 'https://gw.example/v1', apiKey: 'k', models: [{ id: 'x' }] },
      probe,
    )
    if (result.ok) throw new Error('expected a refusal')
    expect(result.message).toContain('OpenCode (https://gw.example/v1)')
    expect(result.message).not.toContain('OpenCode Zen')
    expect(result.message).not.toContain('OpenCode Go')
  })
})

describe('a key the endpoint accepts', () => {
  test('passes, and passes the abort signal down', async () => {
    // Esc during the spinner has to abort the probe, not orphan it behind a
    // screen that is gone.
    const controller = new AbortController()
    const { probe, calls } = fakeProbe({ ok: true })
    const result = await verify.verifyOpencodeFormCredential(
      {
        baseURL: ZEN,
        apiKey: '  sk-good  ',
        models: [{ id: 'claude-opus-5' }],
        signal: controller.signal,
      },
      probe,
    )

    expect(result).toEqual({ ok: true })
    expect(calls[0]?.signal).toBe(controller.signal)
    // Trimmed, so a pasted key with trailing whitespace is not sent as a
    // different credential than the one that gets saved.
    expect(calls[0]?.token).toBe('sk-good')
  })
})

describe('an empty API key', () => {
  test('Zen stays configurable — it is the free tier, not a missing key', async () => {
    // `Bearer public` is what sst/opencode's own plugin sends with no
    // credential, and the free ids answer it with real completions. Refusing an
    // empty key here would break the "free models only" entry point.
    const { probe, calls } = fakeProbe({ ok: true })
    const result = await verify.verifyOpencodeFormCredential(
      { baseURL: ZEN, apiKey: '', models: null },
      probe,
    )

    expect(result).toEqual({ ok: true })
    expect(calls[0]?.token).toBe(catalog.ZEN_PUBLIC_KEY)
    // A free id, not the first of Zen's 61: the public bearer is entitled to
    // those and to nothing else, so probing a paid model asks a different
    // question than the one this check exists to answer.
    expect(calls[0]?.model).toBeDefined()
    expect(catalog.isFreeZenModel(calls[0]?.model ?? '')).toBe(true)
  })

  test('Go says why an empty key cannot work there', async () => {
    // Go has no free tier — not one `-free` id in its 25-model catalog — so
    // occ asks the endpoint rather than guessing, and owns the explanation when
    // the answer is a refusal.
    const { probe, calls } = fakeProbe({
      ok: false,
      reason: 'Missing API key.',
    })
    const result = await verify.verifyOpencodeFormCredential(
      { baseURL: GO, apiKey: '   ', models: null },
      probe,
    )
    if (result.ok) throw new Error('expected a refusal')

    expect(calls[0]?.token).toBe(catalog.ZEN_PUBLIC_KEY)
    // Falls back to occ's shipped Go table, never Zen's.
    expect(catalog.OPENCODE_PRODUCTS.go.models).toContain(calls[0]?.model ?? '')
    expect(result.message).toContain('no free tier')
    expect(result.message).toContain('OpenCode Go')
    expect(result.message).toContain('no API key')
  })

  test('the "free models only" entry counts as keyless, not as a key', async () => {
    // That screen hands the form `public` outright rather than leaving the
    // field empty. Told apart from an empty field, it would be probed like a
    // real key — against `claude-fable-5`, the first of the 61 Zen returns and
    // a paid one — which asks a question the public bearer cannot answer.
    const { probe, calls } = fakeProbe({ ok: true })
    const result = await verify.verifyOpencodeFormCredential(
      {
        baseURL: ZEN,
        apiKey: catalog.ZEN_PUBLIC_KEY,
        models: catalog.OPENCODE_PRODUCTS.zen.models.map(id => ({ id })),
      },
      probe,
    )

    expect(result).toEqual({ ok: true })
    expect(calls[0]?.token).toBe(catalog.ZEN_PUBLIC_KEY)
    expect(catalog.isFreeZenModel(calls[0]?.model ?? '')).toBe(true)
  })

  test('a product that answers anyway is believed', async () => {
    // The absence of a free tier is a fact about the catalog, not a rule occ
    // enforces against the service. If Go ever accepts the public bearer, the
    // credential is accepted.
    const { probe } = fakeProbe({ ok: true })
    expect(
      await verify.verifyOpencodeFormCredential(
        { baseURL: GO, apiKey: '', models: null },
        probe,
      ),
    ).toEqual({ ok: true })
  })
})

describe('when there is nothing to probe with', () => {
  test('an unknown endpoint with no catalog is let through', async () => {
    // Inconclusive is not a refusal — the same call the probe itself makes for
    // a transport failure. Blocking a setup on it would be a worse failure than
    // the one this check prevents.
    const { probe, calls } = fakeProbe({
      ok: false,
      reason: 'Invalid API key.',
    })
    const result = await verify.verifyOpencodeFormCredential(
      { baseURL: 'https://gw.example/v1', apiKey: 'k', models: null },
      probe,
    )

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(0)
  })
})

describe('wiring', () => {
  test('the OpenCode spec is the only one that carries this check', async () => {
    const specs = await import('src/components/providerSetup/specs.js')
    // Identity, so the table stays a table: a wrapper in specs.ts would be a
    // second place for provider-specific behaviour to accumulate.
    expect(specs.PROVIDER_SETUP_SPECS.opencode.verifyCredential).toBe(
      verify.verifyOpencodeFormCredential,
    )
  })
})
