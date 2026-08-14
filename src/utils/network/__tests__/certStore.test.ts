/**
 * CLAUDE_CODE_CERT_STORE parsing. The parser is exported separately from
 * getCACertificates() so the table can be pinned without touching node:tls or
 * the memoized cache.
 */
import { describe, expect, test } from 'bun:test'
import { parseCertStoreSources } from '../caCerts.js'

describe('parseCertStoreSources', () => {
  test('unset or blank means "no opinion" — callers keep their old behavior', () => {
    expect(parseCertStoreSources(undefined)).toBeUndefined()
    expect(parseCertStoreSources('')).toBeUndefined()
    expect(parseCertStoreSources('  ,  ,')).toBeUndefined()
  })

  test('recognizes bundled and system, case- and space-insensitively', () => {
    expect(parseCertStoreSources('bundled')).toEqual(['bundled'])
    expect(parseCertStoreSources('SYSTEM')).toEqual(['system'])
    expect(parseCertStoreSources(' bundled , system ')).toEqual([
      'bundled',
      'system',
    ])
  })

  test('preserves the order given and de-duplicates', () => {
    expect(parseCertStoreSources('system,bundled')).toEqual([
      'system',
      'bundled',
    ])
    expect(parseCertStoreSources('system,system,bundled')).toEqual([
      'system',
      'bundled',
    ])
  })

  test('drops unrecognized sources but keeps the valid ones', () => {
    expect(parseCertStoreSources('bundled,windows-store')).toEqual(['bundled'])
  })

  test('an all-invalid value falls back to "no opinion" rather than no certs', () => {
    expect(parseCertStoreSources('keychain,nss')).toBeUndefined()
  })
})
