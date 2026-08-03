#!/usr/bin/env node
/**
 * Postinstall script — runs automatically after `bun install` or `npm install`.
 *
 * Downloads ripgrep binary (idempotent, skips if exists).
 * Works in dev mode (src/ exists), published mode (dist/ exists), with bun or node.
 *
 * Usage:
 *   node scripts/postinstall.js
 *   node scripts/postinstall.js --force
 *   bun run scripts/postinstall.js
 */

const {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} = require('fs')
const { spawnSync } = require('child_process')
const { createHash } = require('node:crypto')
const { setDefaultResultOrder } = require('node:dns')
const { gunzipSync } = require('node:zlib')
const path = require('path')
const os = require('os')

// Prefer IPv4 first — Bun on Windows sometimes fails GitHub over broken IPv6 paths.
try {
  setDefaultResultOrder('ipv4first')
} catch {
  /* ignore */
}

// --- Config ---

const RG_VERSION = '15.0.1'
const DEFAULT_RELEASE_BASE = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/v${RG_VERSION}`
const RELEASE_BASE = (
  process.env.RIPGREP_DOWNLOAD_BASE ?? DEFAULT_RELEASE_BASE
).replace(/\/$/, '')

// Digests published by microsoft/ripgrep-prebuilt for v15.0.1. A custom
// download base may change transport, never the authenticated artifact bytes.
const RG_ARCHIVE_SHA256 = Object.freeze({
  'ripgrep-v15.0.1-aarch64-apple-darwin.tar.gz':
    '2fa16464fd8638588a67c7fc172d3c4b57fbdc65dff366e10b0b0e90734628a6',
  'ripgrep-v15.0.1-x86_64-apple-darwin.tar.gz':
    '591c693e80bb444ef1907b2a906feb9c77bcafe1cdf509107cc75dcf0e875bd2',
  'ripgrep-v15.0.1-x86_64-pc-windows-msvc.zip':
    'bd28761f4918ea8fcb7a95f636b4422a915d55af268d9805be82d8ce0fdfc823',
  'ripgrep-v15.0.1-aarch64-pc-windows-msvc.zip':
    'cc36bae403f25c838d25a3c65ba64f38cc00904652e89d6377b5ceaf66df8432',
  'ripgrep-v15.0.1-x86_64-unknown-linux-musl.tar.gz':
    '4499958bfd5252df3d9e7504127fd448e4a14fbf2805ef4f14baaa1bcf775188',
  'ripgrep-v15.0.1-aarch64-unknown-linux-musl.tar.gz':
    'dd3738a4b6e8df0fb3bc3edc5af352c4c39e0d97ad118a23e5176bdc5d48ba08',
  'ripgrep-v15.0.1-aarch64-unknown-linux-gnu.tar.gz':
    '301eaf7e580272acb9e370d7b9f4ed9ba0b0fa8c3479e7282a895bbfe0f1076c',
})

const scriptDir = path.dirname(__filename)
const projectRoot = path.resolve(scriptDir, '..')

// --- Platform mapping ---

function getPlatformMapping() {
  const arch = process.arch
  const platform = process.platform

  if (platform === 'darwin') {
    if (arch === 'arm64')
      return { target: 'aarch64-apple-darwin', ext: 'tar.gz' }
    if (arch === 'x64') return { target: 'x86_64-apple-darwin', ext: 'tar.gz' }
    throw new Error(`Unsupported macOS arch: ${arch}`)
  }

  if (platform === 'win32') {
    if (arch === 'x64') return { target: 'x86_64-pc-windows-msvc', ext: 'zip' }
    if (arch === 'arm64')
      return { target: 'aarch64-pc-windows-msvc', ext: 'zip' }
    throw new Error(`Unsupported Windows arch: ${arch}`)
  }

  if (platform === 'linux') {
    const isMusl = detectMusl()
    if (arch === 'x64') {
      return { target: 'x86_64-unknown-linux-musl', ext: 'tar.gz' }
    }
    if (arch === 'arm64') {
      return isMusl
        ? { target: 'aarch64-unknown-linux-musl', ext: 'tar.gz' }
        : { target: 'aarch64-unknown-linux-gnu', ext: 'tar.gz' }
    }
    throw new Error(`Unsupported Linux arch: ${arch}`)
  }

  throw new Error(`Unsupported platform: ${platform}`)
}

function detectMusl() {
  const muslArch = process.arch === 'x64' ? 'x86_64' : 'aarch64'
  try {
    statSync(`/lib/libc.musl-${muslArch}.so.1`)
    return true
  } catch {
    return false
  }
}

// --- Paths ---

function getVendorDir() {
  if (existsSync(path.join(projectRoot, 'src'))) {
    return path.resolve(projectRoot, 'src', 'utils', 'vendor', 'ripgrep')
  }
  return path.resolve(projectRoot, 'dist', 'vendor', 'ripgrep')
}

function getBinaryPath() {
  const dir = getVendorDir()
  const subdir = `${process.arch}-${process.platform}`
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'
  return path.resolve(dir, subdir, binary)
}

// --- Download helpers ---

function proxyEnvSet() {
  const v = s => (s ?? '').trim()
  return !!(
    v(process.env.HTTPS_PROXY) ||
    v(process.env.HTTP_PROXY) ||
    v(process.env.ALL_PROXY) ||
    v(process.env.https_proxy) ||
    v(process.env.http_proxy)
  )
}

function tryPowerShellDownload(url, dest) {
  const u = url.replace(/'/g, "''")
  const d = dest.replace(/'/g, "''")
  const cmd = `Invoke-WebRequest -Uri '${u}' -OutFile '${d}' -UseBasicParsing`
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      cmd,
    ],
    { stdio: 'pipe', windowsHide: true },
  )
  return result.status === 0 && existsSync(dest) && statSync(dest).size > 0
}

function tryCurlDownload(url, dest) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const result = spawnSync(curl, ['-fsSL', '-L', '--fail', '-o', dest, url], {
    stdio: 'pipe',
    windowsHide: true,
  })
  return result.status === 0 && existsSync(dest) && statSync(dest).size > 0
}

async function fetchRelease(url) {
  if (proxyEnvSet()) {
    // Dynamic require so it works in node without bundling issues
    const undici = require('undici')
    return await undici.fetch(url, {
      redirect: 'follow',
      dispatcher: new undici.EnvHttpProxyAgent(),
    })
  }
  // Node 18+ has global fetch, Bun has it too
  return await fetch(url, { redirect: 'follow' })
}

async function downloadUrlToBuffer(url) {
  const response = await fetchRelease(url)
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`,
    )
  }
  return Buffer.from(await response.arrayBuffer())
}

async function downloadUrlToBufferWithFallback(url) {
  let firstError
  try {
    return await downloadUrlToBuffer(url)
  } catch (e) {
    firstError = e
  }

  const tmpRoot = path.join(
    os.tmpdir(),
    `ripgrep-dl-${process.pid}-${Date.now()}`,
  )
  const tmpFile = path.join(tmpRoot, 'archive')
  mkdirSync(tmpRoot, { recursive: true })
  try {
    if (process.platform === 'win32' && tryPowerShellDownload(url, tmpFile)) {
      return readFileSync(tmpFile)
    }
    if (tryCurlDownload(url, tmpFile)) {
      return readFileSync(tmpFile)
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }

  throw firstError
}

// --- Extract ---

function verifyArchiveChecksum(buffer, expectedSha256, assetName) {
  const actualSha256 = createHash('sha256').update(buffer).digest('hex')
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `SHA-256 mismatch for ${assetName}: expected ${expectedSha256}, got ${actualSha256}`,
    )
  }
}

function isExpectedArchiveEntry(entryName, expectedBinary) {
  const normalized = entryName.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.includes('\0')) return false
  const segments = normalized
    .split('/')
    .filter(segment => segment.length > 0 && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return false
  return segments[segments.length - 1] === expectedBinary
}

async function extractZip(buffer, binaryPath, extractedBinary) {
  const { unzipSync } = require('fflate')
  let selectedEntry
  let duplicateEntry = false
  const unzipped = unzipSync(new Uint8Array(buffer), {
    filter(file) {
      if (!isExpectedArchiveEntry(file.name, extractedBinary)) return false
      if (selectedEntry !== undefined) {
        duplicateEntry = true
        return false
      }
      selectedEntry = file.name
      return true
    },
  })
  if (duplicateEntry) {
    throw new Error(`Multiple ${extractedBinary} entries found in zip`)
  }
  if (selectedEntry === undefined || unzipped[selectedEntry] === undefined) {
    throw new Error(`Binary ${extractedBinary} not found in zip`)
  }
  writeFileSync(binaryPath, Buffer.from(unzipped[selectedEntry]))
}

function readTarString(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length)
  const nul = field.indexOf(0)
  return field.subarray(0, nul === -1 ? field.length : nul).toString('utf-8')
}

function readTarSize(header) {
  const raw = readTarString(header, 124, 12).trim()
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Invalid tar entry size: ${JSON.stringify(raw)}`)
  }
  const size = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(size)) {
    throw new Error(`Tar entry size is not a safe integer: ${raw}`)
  }
  return size
}

function extractTarEntry(tarBuffer, extractedBinary) {
  let offset = 0
  let selected
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break

    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const entryName = prefix ? `${prefix}/${name}` : name
    const size = readTarSize(header)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tarBuffer.length) {
      throw new Error(`Truncated tar entry: ${entryName}`)
    }

    const type = header[156]
    const isRegularFile = type === 0 || type === 48
    if (isRegularFile && isExpectedArchiveEntry(entryName, extractedBinary)) {
      if (selected !== undefined) {
        throw new Error(`Multiple ${extractedBinary} entries found in tar`)
      }
      selected = Buffer.from(tarBuffer.subarray(dataStart, dataEnd))
    }

    offset = dataStart + Math.ceil(size / 512) * 512
  }

  if (selected === undefined) {
    throw new Error(`Binary ${extractedBinary} not found in tar`)
  }
  return selected
}

async function extractTarGz(buffer, binaryPath, extractedBinary) {
  const tarBuffer = gunzipSync(buffer, { maxOutputLength: 64 * 1024 * 1024 })
  writeFileSync(binaryPath, extractTarEntry(tarBuffer, extractedBinary))
}

// --- Main ---

async function downloadAndExtract() {
  const { target, ext } = getPlatformMapping()
  const assetName = `ripgrep-v${RG_VERSION}-${target}.${ext}`

  const binaryPath = getBinaryPath()
  const binaryDir = path.dirname(binaryPath)

  const force = process.argv.includes('--force')
  if (!force && existsSync(binaryPath)) {
    const stat = statSync(binaryPath)
    if (stat.size > 0) {
      console.log(`[ripgrep] Binary already exists at ${binaryPath}, skipping.`)
      return
    }
  }

  console.log(`[ripgrep] Downloading v${RG_VERSION} for ${target}...`)

  const extractedBinary = process.platform === 'win32' ? 'rg.exe' : 'rg'

  const expectedSha256 = RG_ARCHIVE_SHA256[assetName]
  if (!expectedSha256) {
    throw new Error(`No pinned SHA-256 for ripgrep asset ${assetName}`)
  }
  const url = `${RELEASE_BASE}/${assetName}`
  console.log(`[ripgrep] Trying ${url}`)
  const buffer = await downloadUrlToBufferWithFallback(url)
  verifyArchiveChecksum(buffer, expectedSha256, assetName)

  try {
    console.log(
      `[ripgrep] Downloaded and verified ${Math.round(buffer.length / 1024)} KB`,
    )

    mkdirSync(binaryDir, { recursive: true })

    if (ext === 'tar.gz') {
      await extractTarGz(buffer, binaryPath, extractedBinary)
    } else {
      await extractZip(buffer, binaryPath, extractedBinary)
    }

    if (process.platform !== 'win32') {
      chmodSync(binaryPath, 0o755)
    }

    console.log(`[ripgrep] Installed to ${binaryPath}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const hint =
      'Check network or set HTTPS_PROXY. If GitHub is blocked, set RIPGREP_DOWNLOAD_BASE to a mirror (see script header).'
    throw new Error(`${msg} ${hint}`)
  }
}

async function main() {
  await downloadAndExtract()
}

if (require.main === module) {
  main().catch(error => {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[postinstall] ripgrep download failed (non-fatal): ${msg}`)
    console.error(
      `[postinstall] You can install ripgrep manually: https://github.com/BurntSushi/ripgrep#installation`,
    )
    // Never exit with error code — postinstall must not break install
    process.exit(0)
  })
}

module.exports = {
  DEFAULT_RELEASE_BASE,
  RELEASE_BASE,
  RG_ARCHIVE_SHA256,
  extractTarEntry,
  extractTarGz,
  extractZip,
  isExpectedArchiveEntry,
  verifyArchiveChecksum,
}
