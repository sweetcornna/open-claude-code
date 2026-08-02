/**
 * Local Chrome detection, used by `occ doctor` and the `/chrome` panel to
 * explain up front whether `--autoConnect` can work.
 *
 * `--autoConnect` needs Chrome 144+ *and* the remote debugging server switched
 * on inside that Chrome. Older Chrome makes chrome-devtools-mcp launch its own
 * browser with a scratch profile instead, which silently loses every login the
 * user expected to have — worth saying out loud before they hit it.
 */
import { readdirSync } from 'fs'
import { join } from 'path'
import memoize from 'lodash-es/memoize.js'
import {
  CHROME_AUTOCONNECT_MIN_MAJOR,
  CHROME_BROWSER_URL_ENV,
} from './common.js'
import { execFileNoThrow } from '../process/execFileNoThrow.js'
import { getPlatform } from '../process/platform.js'
import { which } from '../process/which.js'

export type ChromeDetection = {
  /** Full version string, e.g. `144.0.7204.50`. */
  version: string | null
  /** Major version, or null when Chrome was not found. */
  major: number | null
  /** Path the version was read from. */
  executablePath: string | null
  /** Whether `--autoConnect` can attach to this Chrome. */
  supportsAutoConnect: boolean
  /** Value of the browser-url override, when set. */
  browserUrl: string | null
  /** True when running under WSL, where Chrome usually lives on the host. */
  isWsl: boolean
  /** One line of guidance, or null when nothing needs saying. */
  note: string | null
}

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)\.(\d+)/

const MACOS_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

const LINUX_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
]

function windowsCandidateDirs(): string[] {
  const roots = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
  ].filter((r): r is string => Boolean(r))
  return roots.map(root => join(root, 'Google', 'Chrome', 'Application'))
}

/**
 * Windows Chrome does not print anything for `chrome.exe --version` (it is a
 * GUI subsystem binary, so stdout goes nowhere). The install layout carries
 * the version instead: `Application/<version>/` sits next to `chrome.exe`.
 */
function readWindowsVersion(): {
  version: string
  executablePath: string
} | null {
  for (const dir of windowsCandidateDirs()) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    const versions = entries
      .filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0))
    const newest = versions.at(-1)
    if (newest) {
      return { version: newest, executablePath: join(dir, 'chrome.exe') }
    }
  }
  return null
}

async function readVersionFrom(executablePath: string): Promise<string | null> {
  const { stdout, code } = await execFileNoThrow(
    executablePath,
    ['--version'],
    { timeout: 5_000, useCwd: false, preserveOutputOnError: false },
  )
  if (code !== 0) return null
  return stdout.match(VERSION_RE)?.[0] ?? null
}

async function findChrome(): Promise<{
  version: string
  executablePath: string
} | null> {
  const platform = getPlatform()

  if (platform === 'windows') {
    return readWindowsVersion()
  }

  const candidates =
    platform === 'macos'
      ? MACOS_CANDIDATES
      : await Promise.all(LINUX_CANDIDATES.map(name => which(name))).then(
          paths => paths.filter((p): p is string => Boolean(p)),
        )

  for (const executablePath of candidates) {
    const version = await readVersionFrom(executablePath)
    if (version) return { version, executablePath }
  }
  return null
}

function buildNote(detection: Omit<ChromeDetection, 'note'>): string | null {
  if (detection.browserUrl) {
    return `Connecting to ${detection.browserUrl} (${CHROME_BROWSER_URL_ENV}); the local Chrome version is not used.`
  }
  if (detection.isWsl) {
    return `WSL detected. Chrome on the Windows side is not reachable from here — start it with --remote-debugging-port=9222 and set ${CHROME_BROWSER_URL_ENV}=http://127.0.0.1:9222`
  }
  if (detection.major === null) {
    return `Chrome not found. Install Google Chrome, or set ${CHROME_BROWSER_URL_ENV} to attach to a browser elsewhere.`
  }
  if (!detection.supportsAutoConnect) {
    return `Chrome ${detection.version} is below ${CHROME_AUTOCONNECT_MIN_MAJOR}, so --autoConnect cannot attach to it. A separate browser with an empty profile will be launched instead (no logins).`
  }
  return null
}

async function detect(): Promise<ChromeDetection> {
  const browserUrl = process.env[CHROME_BROWSER_URL_ENV]?.trim() || null
  const isWsl = getPlatform() === 'wsl'
  const found = await findChrome().catch(() => null)
  const parsed = found ? parseInt(found.version, 10) : Number.NaN
  const major = Number.isNaN(parsed) ? null : parsed

  const base = {
    version: found?.version ?? null,
    major,
    executablePath: found?.executablePath ?? null,
    supportsAutoConnect:
      major !== null && major >= CHROME_AUTOCONNECT_MIN_MAJOR,
    browserUrl,
    isWsl,
  }

  return { ...base, note: buildNote(base) }
}

/** Detect the local Chrome install. Memoized — Chrome will not upgrade mid-session. */
export const detectChrome: () => Promise<ChromeDetection> = memoize(detect)
