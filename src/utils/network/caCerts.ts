import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from '../telemetry/debug.js'
import { hasNodeOption } from '../config/envUtils.js'
import { getFsImplementation } from '../filesystem/fsOperations.js'

/**
 * Load CA certificates for TLS connections.
 *
 * Since setting `ca` on an HTTPS agent replaces the default certificate store,
 * we must always include base CAs (either system or bundled Mozilla) when returning.
 *
 * Returns undefined when no custom CA configuration is needed, allowing the
 * runtime's default certificate handling to apply.
 *
 * Behavior:
 * - Neither NODE_EXTRA_CA_CERTS nor --use-system-ca/--use-openssl-ca set: undefined (runtime defaults)
 * - NODE_EXTRA_CA_CERTS only: bundled Mozilla CAs + extra cert file contents
 * - --use-system-ca or --use-openssl-ca only: system CAs
 * - --use-system-ca + NODE_EXTRA_CA_CERTS: system CAs + extra cert file contents
 *
 * Memoized for performance. Call clearCACertsCache() to invalidate after
 * environment variable changes (e.g., after trust dialog applies settings.json).
 *
 * Reads ONLY `process.env.NODE_EXTRA_CA_CERTS`. `caCertsConfig.ts` populates
 * that env var from settings.json at CLI init; this module stays config-free
 * so `proxy.ts`/`mtls.ts` don't transitively pull in the command registry.
 */
/** Trust stores `CLAUDE_CODE_CERT_STORE` can select. */
export type CertStoreSource = 'bundled' | 'system'

const CERT_STORE_SOURCES: readonly CertStoreSource[] = ['bundled', 'system']

/**
 * Parse `CLAUDE_CODE_CERT_STORE`: a comma-separated, case-insensitive list of
 * `bundled` / `system`. Unrecognized entries are dropped with a warning.
 *
 * Returns undefined when the variable is unset or contained nothing usable —
 * callers then fall back to the `--use-system-ca` / `--use-openssl-ca`
 * behavior, so an unset variable changes nothing.
 */
export function parseCertStoreSources(
  raw: string | undefined,
): CertStoreSource[] | undefined {
  if (!raw) return undefined
  const sources: CertStoreSource[] = []
  for (const entry of raw.split(',')) {
    const normalized = entry.trim().toLowerCase()
    if (!normalized) continue
    if ((CERT_STORE_SOURCES as readonly string[]).includes(normalized)) {
      const source = normalized as CertStoreSource
      if (!sources.includes(source)) sources.push(source)
    } else {
      logForDebugging(
        `CA certs: unrecognized CLAUDE_CODE_CERT_STORE source '${normalized}', ignoring`,
        { level: 'warn' },
      )
    }
  }
  return sources.length > 0 ? sources : undefined
}

export const getCACertificates = memoize((): string[] | undefined => {
  // CLAUDE_CODE_CERT_STORE, when it parses to something, is authoritative and
  // outranks the --use-system-ca / --use-openssl-ca node options.
  const certStore = parseCertStoreSources(process.env.CLAUDE_CODE_CERT_STORE)
  const useSystemCA = certStore
    ? certStore.includes('system')
    : hasNodeOption('--use-system-ca') || hasNodeOption('--use-openssl-ca')
  const useBundledCA = certStore ? certStore.includes('bundled') : false

  const extraCertsPath = process.env.NODE_EXTRA_CA_CERTS

  logForDebugging(
    `CA certs: useSystemCA=${useSystemCA}, certStore=${certStore?.join(',') ?? 'unset'}, extraCertsPath=${extraCertsPath}`,
  )

  // If nothing selects a store, return undefined (use runtime defaults).
  if (!useSystemCA && !useBundledCA && !extraCertsPath) {
    return undefined
  }

  // Deferred load: Bun's node:tls module eagerly materializes ~150 Mozilla
  // root certificates (~750KB heap) on import, even if tls.rootCertificates
  // is never accessed. Most users hit the early return above, so we only
  // pay this cost when custom CA handling is actually needed.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const tls = require('tls') as typeof import('tls')
  /* eslint-enable @typescript-eslint/no-require-imports */

  const certs: string[] = []

  // `CLAUDE_CODE_CERT_STORE=bundled,system` wants both stores, so bundled goes
  // in first and the system branch below appends to it rather than replacing.
  if (useBundledCA) {
    certs.push(...tls.rootCertificates)
    logForDebugging(
      `CA certs: Loaded ${certs.length} bundled root certificates (CLAUDE_CODE_CERT_STORE)`,
    )
  }

  if (useSystemCA) {
    // Load system CA store (Bun API)
    const getCACerts = (
      tls as typeof tls & { getCACertificates?: (type: string) => string[] }
    ).getCACertificates
    const systemCAs = getCACerts?.('system')
    if (systemCAs && systemCAs.length > 0) {
      certs.push(...systemCAs)
      logForDebugging(
        `CA certs: Loaded ${systemCAs.length} system CA certificates`,
      )
    } else if (!getCACerts && !extraCertsPath && !useBundledCA) {
      // Under Node.js where getCACertificates doesn't exist and no extra certs,
      // return undefined to let Node.js handle --use-system-ca natively.
      logForDebugging(
        'CA certs: system store selected but system CA API unavailable, deferring to runtime',
      )
      return undefined
    } else if (!useBundledCA) {
      // System CA API returned empty or unavailable; fall back to bundled root certs
      certs.push(...tls.rootCertificates)
      logForDebugging(
        `CA certs: Loaded ${certs.length} bundled root certificates as base (system store fallback)`,
      )
    }
  } else if (!useBundledCA) {
    // Must include bundled Mozilla CAs as base since ca replaces defaults
    certs.push(...tls.rootCertificates)
    logForDebugging(
      `CA certs: Loaded ${certs.length} bundled root certificates as base`,
    )
  }

  // Append extra certs from file
  if (extraCertsPath) {
    try {
      const extraCert = getFsImplementation().readFileSync(extraCertsPath, {
        encoding: 'utf8',
      })
      certs.push(extraCert)
      logForDebugging(
        `CA certs: Appended extra certificates from NODE_EXTRA_CA_CERTS (${extraCertsPath})`,
      )
    } catch (error) {
      logForDebugging(
        `CA certs: Failed to read NODE_EXTRA_CA_CERTS file (${extraCertsPath}): ${error}`,
        { level: 'error' },
      )
    }
  }

  return certs.length > 0 ? certs : undefined
})

/**
 * Clear the CA certificates cache.
 * Call this when environment variables that affect CA certs may have changed
 * (e.g., NODE_EXTRA_CA_CERTS, NODE_OPTIONS).
 */
export function clearCACertsCache(): void {
  getCACertificates.cache.clear?.()
  logForDebugging('Cleared CA certificates cache')
}
