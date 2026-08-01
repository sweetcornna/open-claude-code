import { IssuerMismatchError } from '@modelcontextprotocol/client'
import { describe, expect, test } from 'bun:test'
import {
  assertAuthorizationResponseIssuer,
  type IssuerBaseline,
  isAuthorizationResponseIssuerMismatch,
  issuerBaselineFromMetadata,
  NO_ISSUER_BASELINE,
} from '../oauthIssuer.js'

const ISSUER = 'https://auth.example.com'
const OTHER_ISSUER = 'https://evil.example.com'

const advertised: IssuerBaseline = {
  expectedIssuer: ISSUER,
  issParameterSupported: true,
}
const notAdvertised: IssuerBaseline = {
  expectedIssuer: ISSUER,
  issParameterSupported: false,
}

/** Both callback query shapes occ parses, so the table runs against each. */
const shapes = {
  'URLSearchParams (pasted callback URL)': (entries: Array<[string, string]>) =>
    new URLSearchParams(entries),
  'ParsedUrlQuery (loopback callback server)': (
    entries: Array<[string, string]>,
  ) => {
    const query: Record<string, string | string[] | undefined> = {}
    for (const [key, value] of entries) {
      const existing = query[key]
      if (existing === undefined) {
        query[key] = value
      } else if (Array.isArray(existing)) {
        existing.push(value)
      } else {
        query[key] = [existing, value]
      }
    }
    return query
  },
} as const

describe('issuerBaselineFromMetadata', () => {
  test('reads issuer and the RFC 9207 support flag from metadata', () => {
    expect(
      issuerBaselineFromMetadata({
        issuer: ISSUER,
        authorization_response_iss_parameter_supported: true,
      }),
    ).toEqual({ expectedIssuer: ISSUER, issParameterSupported: true })
  })

  test('treats a missing support flag as not advertised', () => {
    expect(issuerBaselineFromMetadata({ issuer: ISSUER })).toEqual({
      expectedIssuer: ISSUER,
      issParameterSupported: false,
    })
  })

  test('only a literal true counts as advertised', () => {
    // The v1 SDK's metadata schema does not know this field, so a server can
    // put anything here and it survives the loose parse untouched.
    for (const value of ['true', 1, {}, null]) {
      expect(
        issuerBaselineFromMetadata({
          issuer: ISSUER,
          authorization_response_iss_parameter_supported: value,
        }).issParameterSupported,
      ).toBe(false)
    }
  })

  test('yields no baseline for absent, non-object, or issuer-less metadata', () => {
    expect(issuerBaselineFromMetadata(undefined)).toEqual(NO_ISSUER_BASELINE)
    expect(issuerBaselineFromMetadata(null)).toEqual(NO_ISSUER_BASELINE)
    expect(issuerBaselineFromMetadata('https://auth.example.com')).toEqual(
      NO_ISSUER_BASELINE,
    )
    expect(issuerBaselineFromMetadata({}).expectedIssuer).toBeUndefined()
    expect(issuerBaselineFromMetadata({ issuer: '' }).expectedIssuer).toBe(
      undefined,
    )
    expect(issuerBaselineFromMetadata({ issuer: 42 }).expectedIssuer).toBe(
      undefined,
    )
  })
})

describe('assertAuthorizationResponseIssuer', () => {
  for (const [shapeName, build] of Object.entries(shapes)) {
    describe(shapeName, () => {
      test('rejects a mismatched iss when the server advertises support', () => {
        expect(() =>
          assertAuthorizationResponseIssuer(
            build([
              ['code', 'abc'],
              ['iss', OTHER_ISSUER],
            ]),
            advertised,
          ),
        ).toThrow(IssuerMismatchError)
      })

      test('rejects a mismatched iss even when support is not advertised', () => {
        // RFC 9207 §2.4: a present `iss` is authoritative regardless of what
        // the metadata advertises.
        expect(() =>
          assertAuthorizationResponseIssuer(
            build([['iss', OTHER_ISSUER]]),
            notAdvertised,
          ),
        ).toThrow(IssuerMismatchError)
      })

      test('rejects an absent iss when the server advertises support', () => {
        expect(() =>
          assertAuthorizationResponseIssuer(
            build([['code', 'abc']]),
            advertised,
          ),
        ).toThrow(IssuerMismatchError)
      })

      test('proceeds on an exact match', () => {
        expect(() =>
          assertAuthorizationResponseIssuer(
            build([
              ['code', 'abc'],
              ['iss', ISSUER],
            ]),
            advertised,
          ),
        ).not.toThrow()
      })

      test('proceeds when iss is absent and support is not advertised', () => {
        expect(() =>
          assertAuthorizationResponseIssuer(
            build([['code', 'abc']]),
            notAdvertised,
          ),
        ).not.toThrow()
      })

      test('rejects a repeated iss parameter', () => {
        // Whichever duplicate a parser happens to surface, an attacker who can
        // append a second `iss` must not be able to pick the one we compare.
        expect(() =>
          assertAuthorizationResponseIssuer(
            build([
              ['iss', ISSUER],
              ['iss', OTHER_ISSUER],
            ]),
            advertised,
          ),
        ).toThrow(IssuerMismatchError)
        expect(() =>
          assertAuthorizationResponseIssuer(
            build([
              ['iss', ISSUER],
              ['iss', ISSUER],
            ]),
            advertised,
          ),
        ).toThrow(IssuerMismatchError)
      })

      test('compares by simple string equality (RFC 3986 §6.2.1)', () => {
        // No case folding, no trailing-slash or default-port normalization.
        for (const nearMiss of [
          `${ISSUER}/`,
          'https://AUTH.example.com',
          'https://auth.example.com:443',
        ]) {
          expect(() =>
            assertAuthorizationResponseIssuer(
              build([['iss', nearMiss]]),
              advertised,
            ),
          ).toThrow(IssuerMismatchError)
        }
      })

      test('is a no-op without a baseline, whatever iss says', () => {
        // No metadata was obtained, so there is nothing authentic to compare
        // against; failing closed here would break every server whose metadata
        // fetch we could not complete.
        for (const entries of [
          [] as Array<[string, string]>,
          [['iss', OTHER_ISSUER]] as Array<[string, string]>,
          [
            ['iss', ISSUER],
            ['iss', OTHER_ISSUER],
          ] as Array<[string, string]>,
        ]) {
          expect(() =>
            assertAuthorizationResponseIssuer(
              build(entries),
              NO_ISSUER_BASELINE,
            ),
          ).not.toThrow()
        }
      })
    })
  }

  test('reports the expected and received issuers on the thrown error', () => {
    let thrown: unknown
    try {
      assertAuthorizationResponseIssuer(
        new URLSearchParams([['iss', OTHER_ISSUER]]),
        advertised,
      )
    } catch (error) {
      thrown = error
    }
    expect(isAuthorizationResponseIssuerMismatch(thrown)).toBe(true)
    const mismatch = thrown as IssuerMismatchError
    expect(mismatch.kind).toBe('authorization_response')
    expect(mismatch.expected).toBe(ISSUER)
    expect(mismatch.received).toBe(OTHER_ISSUER)
  })
})

describe('isAuthorizationResponseIssuerMismatch', () => {
  test('does not match the RFC 8414 metadata-echo variant', () => {
    // Same class, different check — only the callback variant should map to
    // the flow's `issuer_mismatch` telemetry reason.
    expect(
      isAuthorizationResponseIssuerMismatch(
        new IssuerMismatchError('metadata', ISSUER, OTHER_ISSUER),
      ),
    ).toBe(false)
  })

  test('does not match unrelated errors', () => {
    expect(isAuthorizationResponseIssuerMismatch(new Error('nope'))).toBe(false)
    expect(isAuthorizationResponseIssuerMismatch(undefined)).toBe(false)
  })
})
