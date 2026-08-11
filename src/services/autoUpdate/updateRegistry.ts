/**
 * Which npm registry occ's own self-update talks to.
 *
 * Why this exists: the update path is network-bound and the bottleneck is not
 * the origin, it is the edge. Measured from one user's machine at a single
 * moment, against the very same 8.3 MB tarball:
 *
 *   registry.npmjs.org      17,599 B/s   ~8 minutes
 *   registry.npmmirror.com   1,101,809 B/s      7.6 s
 *
 * and a real `bun install -g @sweetcornna/open-claude-code@2.38.1` took
 * 347.93 s wall for 0.19 s user / 0.42 s sys — i.e. essentially all of it was
 * waiting on the network. So occ probes the candidates concurrently and sends
 * both halves of the update (the `npm view` version check and the
 * `install -g`) to whichever answered fastest.
 *
 * Four rules keep this from being merely fast:
 *
 *  1. occ never mutates the user's npm/bun configuration. Nothing here writes
 *     `~/.npmrc`, `~/.bunfig.toml` or any global config; the choice is passed
 *     per invocation as `--registry=<url>`, which npm and bun both accept and
 *     which is scoped to that one child process. occ's self-update is the only
 *     traffic that gets redirected.
 *  2. An explicitly configured registry wins and is never raced. If the user
 *     set one — `NPM_CONFIG_REGISTRY`, an `.npmrc` entry (which is what
 *     `npm config get registry` reports), or a bunfig `[install] registry` —
 *     that is a deliberate choice, quite possibly a private mirror that is the
 *     only host carrying the package at all. Racing it against public
 *     registries could only ever make things worse.
 *  3. The probe is cheap. Racing full downloads would burn exactly the
 *     bandwidth this is supposed to save; see `probeTarballThroughput`.
 *  4. A mirror is a third party, so nothing it says is taken on faith. See
 *     `approveRegistryForInstall` for the integrity gate and for the precise
 *     shape of the guarantee.
 *
 * Escape hatch: `OCC_UPDATE_REGISTRY=official` pins registry.npmjs.org and
 * skips probing entirely. The same variable also accepts an explicit registry
 * URL, which is likewise used as-is without probing.
 */
import { NPM_PACKAGE_NAME } from 'src/constants/brand.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isSafeRegistryUrl } from 'src/utils/process/packageManager.js'
import { createAbortController } from 'src/utils/process/abortController.js'
import { createCombinedAbortSignal } from 'src/utils/process/combinedAbortSignal.js'
import { execFileNoThrowWithCwd } from 'src/utils/process/execFileNoThrow.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'

/**
 * The canonical registry: the source of truth for what "latest" is, the source
 * of the integrity hashes every mirror is checked against, and the fallback
 * whenever anything below is unavailable or inconclusive.
 */
export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org'

/**
 * The registries occ is willing to race, in no particular order (the race
 * decides). Deliberately short: every entry here is a host occ may hand a
 * self-install to, so the bar is "publicly reachable, unauthenticated, mirrors
 * the whole npm tree, and is operated by someone identifiable".
 *
 *  - registry.npmjs.org      the origin. Always in the race, so a user whose
 *                            path to npm is healthy is never redirected.
 *  - registry.yarnpkg.com    the same npm registry content behind a different
 *                            CDN, operated by the Yarn project. Included
 *                            because the failure being worked around is
 *                            usually a degraded edge rather than a degraded
 *                            origin, and this reaches the same bytes by
 *                            another path — no China-specific assumption.
 *  - registry.npmmirror.com  Alibaba's public full mirror of npm (formerly
 *                            cnpm/taobao). Included because it is the entry
 *                            measured to actually change the outcome: 1.6 MB/s
 *                            against 37 KB/s for the two above, from a network
 *                            where npm's edge is the bottleneck.
 *
 * Adding to this list means adding somebody occ will install from. Do not grow
 * it casually, and do not replace it with a single region-specific mirror.
 */
export const UPDATE_REGISTRY_CANDIDATES: readonly string[] = [
  OFFICIAL_NPM_REGISTRY,
  'https://registry.yarnpkg.com',
  'https://registry.npmmirror.com',
]

/** Documented escape hatch; see the module header. */
export const UPDATE_REGISTRY_ENV_VAR = 'OCC_UPDATE_REGISTRY'

/**
 * How the registry was chosen. Only `raced` means occ picked a third party on
 * the user's behalf, and that is exactly the case that owes the user an
 * integrity gate before anything is installed.
 */
export type UpdateRegistrySource =
  | 'configured'
  | 'pinned'
  | 'official'
  | 'raced'

export type UpdateRegistryChoice = {
  registry: string
  source: UpdateRegistrySource
}

/**
 * How many bytes of the real tarball a candidate must deliver to win.
 *
 * 64 KiB is chosen to measure throughput rather than latency: a few-KB probe
 * completes inside TCP slow start and mostly reports the handshake, which is
 * not what hurts here — an 8.3 MB transfer is. At the slow end measured above
 * (~37 KB/s) 64 KiB takes ~1.7 s, comfortably inside the timeout; at the fast
 * end it is ~40 ms. Worst-case waste is one probe's worth per candidate, and
 * the losers are aborted the instant a winner appears, so in practice a race
 * costs a little over 64 KiB total.
 */
const PROBE_BYTES = 64 * 1024

/**
 * Ceiling for the whole race. Long enough that the slow path can still finish
 * 64 KiB and win when it is the only candidate reachable, short enough that a
 * user running `occ update` does not notice it.
 */
const PROBE_TIMEOUT_MS = 3_000

/** Bound on the metadata reads used for the integrity gate (~7.5 KB each). */
const METADATA_TIMEOUT_MS = 10_000

/** `npm config get registry` is a local config read; it measured 89 ms. */
const NPM_CONFIG_TIMEOUT_MS = 5_000

/**
 * Registry URLs are compared and formatted a lot; normalise once so that
 * `https://registry.npmjs.org/` and `https://registry.npmjs.org` are not
 * treated as two different registries (npm reports the trailing slash form).
 */
export function normalizeRegistryUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const path = parsed.pathname.replace(/\/+$/, '')
  const normalized = `${parsed.protocol}//${parsed.host}${path}`
  // Defence in depth: this string ends up on a command line (npm and bun are
  // .cmd shims on Windows, so the spawn goes through cmd.exe). Anything that
  // could not survive that is not a registry we are willing to use.
  return isSafeRegistryUrl(normalized) ? normalized : null
}

function isOfficialRegistry(registry: string): boolean {
  return registry === OFFICIAL_NPM_REGISTRY
}

/**
 * `--registry=<url>` for one child process, or nothing.
 *
 * Both package managers document this flag as overriding their own
 * configuration for that invocation only — verified against npm 11.16.0 and
 * bun 1.3.13 by pointing both at a local registry and watching every request
 * arrive there. Nothing on disk is touched.
 */
export function registryCliArgs(registry: string | undefined): string[] {
  if (!registry || !isSafeRegistryUrl(registry)) return []
  return [`--registry=${registry}`]
}

type PackageDist = {
  version: string
  integrity: string | null
  shasum: string | null
}

export type FetchVersionDist = (
  registry: string,
  packageName: string,
  version: string,
  signal: AbortSignal,
) => Promise<PackageDist | null>

/** `@scope/name` → `@scope%2fname`, the documented packument path form. */
function encodePackagePath(packageName: string): string {
  return packageName.replace('/', '%2f')
}

/**
 * `<registry>/@scope/name/-/name-<version>.tgz`, matching what npm publishes
 * as `dist.tarball`. The scope stays unencoded here and the basename drops it
 * — that asymmetry is npm's, not a mistake.
 */
function tarballUrl(
  registry: string,
  packageName: string,
  version: string,
): string {
  const basename = packageName.slice(packageName.lastIndexOf('/') + 1)
  return `${registry}/${packageName}/-/${basename}-${version}.tgz`
}

/**
 * Read the real tarball, not a synthetic endpoint, and stop at PROBE_BYTES.
 *
 * The thing being measured is the path that will carry ~8 MB in a moment, and
 * on a mirror that is a different host from its metadata endpoint (npmmirror
 * redirects tarballs to cdn.npmmirror.com — `fetch` follows it, which is the
 * point). A packument probe would rank a registry whose metadata is local and
 * whose CDN is not, and it would not notice a mirror that simply does not
 * carry this package.
 *
 * The Range header is a request, not a guarantee; a registry that ignores it
 * would stream the whole tarball, so the read is bounded by the loop as well
 * and the body is cancelled as soon as enough has arrived.
 *
 * Resolving requires a full PROBE_BYTES: occ's tarball is megabytes, so
 * anything shorter is an error page or a truncated response, not a win.
 */
async function probeTarballThroughput(
  registry: string,
  packageName: string,
  version: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(tarballUrl(registry, packageName, version), {
    headers: {
      range: `bytes=0-${PROBE_BYTES - 1}`,
      // Keeps the byte count meaning what it looks like: a .tgz gains nothing
      // from transfer encoding, and Range plus Content-Encoding is ambiguous.
      'accept-encoding': 'identity',
    },
    signal,
  })
  if (!response.ok || !response.body) {
    throw new Error(`${registry}: HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  let received = 0
  try {
    while (received < PROBE_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  if (received < PROBE_BYTES) {
    throw new Error(`${registry}: only ${received} bytes`)
  }
}

export type RegistryProbe = (
  registry: string,
  packageName: string,
  version: string,
  signal: AbortSignal,
) => Promise<void>

/**
 * Run every candidate at once and return the first to finish its probe.
 *
 * Concurrent rather than sequential on purpose: measuring a slow registry
 * first would cost the whole timeout before the fast one is even tried, which
 * on the networks this targets is most of the latency it is meant to remove.
 *
 * Returns null when every candidate fails or the timeout expires — an
 * inconclusive race is not a reason to pick anything, so the caller falls back
 * to the official registry.
 */
export async function raceRegistries(
  candidates: readonly string[],
  packageName: string,
  version: string,
  options?: {
    probe?: RegistryProbe
    signal?: AbortSignal
    timeoutMs?: number
  },
): Promise<string | null> {
  const probe = options?.probe ?? probeTarballThroughput
  // Aborted as soon as somebody wins, so the losers stop pulling bytes.
  const raceController = createAbortController()
  const { signal, cleanup } = createCombinedAbortSignal(options?.signal, {
    signalB: raceController.signal,
    timeoutMs: options?.timeoutMs ?? PROBE_TIMEOUT_MS,
  })
  try {
    const winner = await Promise.any(
      candidates.map(async registry => {
        await probe(registry, packageName, version, signal)
        return registry
      }),
    )
    return winner
  } catch {
    // AggregateError: nobody finished. Also the empty-candidates case.
    return null
  } finally {
    raceController.abort()
    cleanup()
  }
}

/**
 * `npm config get registry`, resolving the whole npmrc chain the way npm
 * itself does — builtin, global, user, and `NPM_CONFIG_*` env vars.
 *
 * Run from the home directory for the same reason the installer is: a
 * project-level `.npmrc` must not be able to steer occ's self-update, and the
 * detection has to agree with the process that will actually install.
 */
async function readNpmConfigRegistry(
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['config', 'get', 'registry'],
    { abortSignal: signal, cwd: homedir(), timeout: NPM_CONFIG_TIMEOUT_MS },
  )
  if (result.code !== 0) return null
  const value = result.stdout.trim()
  // npm prints the string "undefined" when a key has no value.
  if (!value || value === 'undefined' || value === 'null') return null
  return value
}

/**
 * bunfig's `[install] registry`, which `npm config` cannot see.
 *
 * Deliberately a targeted read rather than a TOML parser: the only question is
 * "did the user pick a registry", and the cost of a false negative (occ races
 * past a choice the user made) is worse than the cost of a false positive
 * (occ honours a registry the user wrote down). Both documented spellings are
 * accepted — a bare string and the `{ url = "…" }` table.
 */
function readBunfigRegistry(): string | null {
  const candidates = [
    join(homedir(), '.bunfig.toml'),
    ...(process.env.XDG_CONFIG_HOME
      ? [join(process.env.XDG_CONFIG_HOME, '.bunfig.toml')]
      : []),
  ]
  for (const path of candidates) {
    let contents: string
    try {
      contents = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const match = contents.match(
      /^\s*registry\s*=\s*(?:"([^"]+)"|'([^']+)'|\{[^}]*\burl\s*=\s*"([^"]+)")/m,
    )
    const value = match?.[1] ?? match?.[2] ?? match?.[3]
    if (value) return value
  }
  return null
}

export type ResolveUpdateRegistryOptions = {
  /**
   * The version whose tarball the probe reads. The currently running one:
   * it is published by definition, it lives at the same CDN path as the
   * version about to be downloaded, and using it avoids needing the version
   * check to have happened first — which is itself one of the things being
   * accelerated here.
   */
  probeVersion: string
  packageName?: string
  candidates?: readonly string[]
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  probe?: RegistryProbe
  probeTimeoutMs?: number
  getNpmConfigRegistry?: (signal?: AbortSignal) => Promise<string | null>
  getBunfigRegistry?: () => string | null
}

/**
 * Decide where this process's self-update traffic goes.
 *
 * Order is the whole design: explicit user configuration and the escape hatch
 * short-circuit before any network request, so the common "I pointed npm at
 * my company mirror" case costs one 89 ms local config read and no probing at
 * all.
 */
export async function resolveUpdateRegistry(
  options: ResolveUpdateRegistryOptions,
): Promise<UpdateRegistryChoice> {
  const env = options.env ?? process.env
  const packageName = options.packageName ?? NPM_PACKAGE_NAME

  const pinned = env[UPDATE_REGISTRY_ENV_VAR]?.trim()
  if (pinned) {
    if (pinned.toLowerCase() === 'official') {
      return { registry: OFFICIAL_NPM_REGISTRY, source: 'pinned' }
    }
    const normalized = normalizeRegistryUrl(pinned)
    if (normalized) {
      return { registry: normalized, source: 'pinned' }
    }
    logForDebugging(
      `updateRegistry: ignoring unusable ${UPDATE_REGISTRY_ENV_VAR}=${pinned}`,
    )
  }

  // Each source is consulted until one names something other than the default
  // registry. Chaining with `??` instead would be a silent bug: `npm config
  // get registry` always answers, so it would report the default and the
  // bunfig read below would be unreachable — a bun user's own choice would be
  // raced past. Order follows npm's precedence, and the env vars come first
  // because reading them saves the spawn for users who set it that way.
  const configuredSources: Array<() => string | null | Promise<string | null>> =
    [
      () => env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? null,
      () =>
        (options.getNpmConfigRegistry ?? readNpmConfigRegistry)(options.signal),
      () => (options.getBunfigRegistry ?? readBunfigRegistry)(),
    ]
  for (const readSource of configuredSources) {
    const raw = await readSource()
    const normalized = raw ? normalizeRegistryUrl(raw) : null
    if (normalized && !isOfficialRegistry(normalized)) {
      logForDebugging(
        `updateRegistry: honouring configured registry ${normalized}`,
      )
      return { registry: normalized, source: 'configured' }
    }
  }

  const winner = await raceRegistries(
    options.candidates ?? UPDATE_REGISTRY_CANDIDATES,
    packageName,
    options.probeVersion,
    {
      probe: options.probe,
      signal: options.signal,
      timeoutMs: options.probeTimeoutMs,
    },
  )
  if (!winner || isOfficialRegistry(winner)) {
    logForDebugging(
      winner
        ? 'updateRegistry: official registry won the race'
        : 'updateRegistry: no candidate answered; using the official registry',
    )
    return { registry: OFFICIAL_NPM_REGISTRY, source: 'official' }
  }
  logForDebugging(`updateRegistry: raced and chose ${winner}`)
  return { registry: winner, source: 'raced' }
}

/**
 * Session-scoped memo of the choice above.
 *
 * The background loop wakes every 30 minutes for the rest of the session;
 * re-racing on each pass would spend the probe budget over and over to answer
 * a question whose answer does not usually change within one session. Probing
 * once per process also keeps `occ update` deterministic and keeps a user
 * watching their own traffic from seeing an unexplained registry request every
 * half hour. A new process re-probes, so a network that improves is picked up
 * at the next launch.
 */
let cachedChoice: Promise<UpdateRegistryChoice> | undefined

export function getSessionUpdateRegistry(
  options: ResolveUpdateRegistryOptions,
): Promise<UpdateRegistryChoice> {
  cachedChoice ??= resolveUpdateRegistry(options).catch(error => {
    // Never let a probe failure poison the session; fall back and forget.
    cachedChoice = undefined
    logForDebugging(`updateRegistry: resolution failed (${error})`)
    return { registry: OFFICIAL_NPM_REGISTRY, source: 'official' as const }
  })
  return cachedChoice
}

export function resetUpdateRegistryCacheForTests(): void {
  cachedChoice = undefined
}

/**
 * `<registry>/<pkg>/<version>` — one version manifest, ~7.5 KB, which is where
 * `dist.integrity` lives. The abbreviated packument for this package is 253 KB
 * and grows with every release; the single-version document does not.
 */
async function fetchVersionDist(
  registry: string,
  packageName: string,
  version: string,
  signal: AbortSignal,
): Promise<PackageDist | null> {
  const url = `${registry}/${encodePackagePath(packageName)}/${version}`
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal,
  })
  if (!response.ok) return null
  const body = (await response.json()) as {
    version?: unknown
    dist?: { integrity?: unknown; shasum?: unknown }
  }
  if (typeof body.version !== 'string') return null
  return {
    version: body.version,
    integrity:
      typeof body.dist?.integrity === 'string' ? body.dist.integrity : null,
    shasum: typeof body.dist?.shasum === 'string' ? body.dist.shasum : null,
  }
}

export type ApproveRegistryOptions = {
  choice: UpdateRegistryChoice
  version: string
  packageName?: string
  signal?: AbortSignal
  fetchDist?: FetchVersionDist
  metadataTimeoutMs?: number
}

/**
 * The integrity gate. Returns the registry the install may actually use.
 *
 * What is guaranteed, and how:
 *
 *  1. occ reads `dist.integrity` for the exact version about to be installed
 *     from the **official** registry — the small single-version document, not
 *     the packument — and requires the raced mirror to advertise the same
 *     value for the same version. A mirror that disagrees, that is missing the
 *     version, or that cannot be reached is discarded here and the install
 *     falls back to registry.npmjs.org.
 *  2. npm and bun then verify the downloaded tarball against the integrity in
 *     the packument they fetched, which step 1 has just pinned to the official
 *     value. This was verified rather than assumed: pointing each at a local
 *     registry that served honest `dist.integrity` metadata alongside a
 *     corrupted tarball, npm 11.16.0 refused with `EINTEGRITY` and bun 1.3.13
 *     with `IntegrityCheckFailed`, and neither left anything installed.
 *
 * Together those give an end-to-end property worth stating plainly: the bytes
 * that get unpacked hash to the value npm published, even though they came
 * from a mirror.
 *
 * What is **not** guaranteed, stated equally plainly: there is no post-install
 * verification, and there cannot be one with these package managers. Both
 * unpack the tarball and discard it, gzip is not reproducible, so the
 * installed tree cannot be hashed back to `dist.integrity`; and the background
 * install is a detached child that by design outlives the session that started
 * it, so there is no process left to check afterwards even if the hash were
 * recoverable. The pre-install gate above is what occ can actually promise.
 * The residual gap is a mirror that serves one packument to occ and a
 * different one to the package manager moments later — a targeted attack, not
 * a passive one, and the reason the official registry remains the fallback for
 * everything inconclusive.
 *
 * Note the gate deliberately applies to `raced` only. A registry the user
 * configured themselves is their trust anchor, not occ's guess, and it may
 * legitimately host a build that is not on npmjs at all; holding it to the
 * public hash would break exactly the users rule 2 exists to protect.
 */
export async function approveRegistryForInstall(
  options: ApproveRegistryOptions,
): Promise<string> {
  const { choice, version } = options
  if (choice.source !== 'raced') {
    return choice.registry
  }
  const packageName = options.packageName ?? NPM_PACKAGE_NAME
  const fetchDist = options.fetchDist ?? fetchVersionDist
  const { signal, cleanup } = createCombinedAbortSignal(options.signal, {
    timeoutMs: options.metadataTimeoutMs ?? METADATA_TIMEOUT_MS,
  })
  try {
    const [expected, actual] = await Promise.all([
      fetchDist(OFFICIAL_NPM_REGISTRY, packageName, version, signal),
      fetchDist(choice.registry, packageName, version, signal),
    ])
    if (!expected) {
      logForDebugging(
        `updateRegistry: no official integrity for ${version}; not using ${choice.registry}`,
      )
      return OFFICIAL_NPM_REGISTRY
    }
    if (!actual || actual.version !== expected.version) {
      logForDebugging(
        `updateRegistry: ${choice.registry} does not serve ${version}; falling back`,
      )
      return OFFICIAL_NPM_REGISTRY
    }
    // sha512 `integrity` is what npm and bun enforce; `shasum` is the legacy
    // fallback for versions published before integrity existed. Whichever the
    // official document offers is the one the mirror has to match, and if it
    // offers neither there is nothing to check against.
    const matched = expected.integrity
      ? actual.integrity === expected.integrity
      : expected.shasum
        ? actual.shasum === expected.shasum
        : false
    if (!matched) {
      logForDebugging(
        `updateRegistry: integrity mismatch for ${version} at ${choice.registry}; falling back`,
      )
      return OFFICIAL_NPM_REGISTRY
    }
    return choice.registry
  } catch (error) {
    logForDebugging(`updateRegistry: integrity check failed (${error})`)
    return OFFICIAL_NPM_REGISTRY
  } finally {
    cleanup()
  }
}
