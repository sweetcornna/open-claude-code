import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { zipSync } from 'fflate'

type PostinstallModule = {
  DEFAULT_RELEASE_BASE: string
  RELEASE_BASE: string
  RG_ARCHIVE_SHA256: Record<string, string>
  extractTarGz(
    buffer: Buffer,
    binaryPath: string,
    extractedBinary: string,
  ): Promise<void>
  extractZip(
    buffer: Buffer,
    binaryPath: string,
    extractedBinary: string,
  ): Promise<void>
  isExpectedArchiveEntry(entryName: string, expectedBinary: string): boolean
  verifyArchiveChecksum(
    buffer: Buffer,
    expectedSha256: string,
    assetName: string,
  ): void
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const postinstall = require('../postinstall.cjs') as PostinstallModule

function tarArchive(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf-8')
    header.write(`${entry.data.length.toString(8).padStart(11, '0')}\0`, 124)
    header[156] = '0'.charCodeAt(0)
    chunks.push(header, entry.data)
    const padding = (512 - (entry.data.length % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

describe('postinstall ripgrep integrity', () => {
  test('pins a SHA-256 for every supported release asset', () => {
    expect(Object.keys(postinstall.RG_ARCHIVE_SHA256)).toHaveLength(7)
    for (const digest of Object.values(postinstall.RG_ARCHIVE_SHA256)) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(
      postinstall.RG_ARCHIVE_SHA256[
        'ripgrep-v15.0.1-aarch64-unknown-linux-gnu.tar.gz'
      ],
    ).toBe('301eaf7e580272acb9e370d7b9f4ed9ba0b0fa8c3479e7282a895bbfe0f1076c')
  })

  test('rejects a downloaded archive whose SHA-256 does not match', () => {
    const archive = Buffer.from('downloaded bytes')
    const expected = createHash('sha256').update(archive).digest('hex')
    expect(() =>
      postinstall.verifyArchiveChecksum(archive, expected, 'asset.tar.gz'),
    ).not.toThrow()
    expect(() =>
      postinstall.verifyArchiveChecksum(
        Buffer.from('tampered bytes'),
        expected,
        'asset.tar.gz',
      ),
    ).toThrow(/SHA-256 mismatch/)
  })

  test('has no automatic third-party mirror fallback', async () => {
    const source = await readFile(
      join(import.meta.dir, '..', 'postinstall.cjs'),
      'utf-8',
    )
    expect(postinstall.DEFAULT_RELEASE_BASE).toMatch(
      /^https:\/\/github\.com\/microsoft\/ripgrep-prebuilt\//,
    )
    expect(postinstall.RELEASE_BASE).not.toContain('ghproxy')
    expect(source).not.toContain('ghproxy.net')
  })
})

describe('postinstall ripgrep archive extraction', () => {
  test('ZIP extraction writes only the single expected binary entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'postinstall-zip-'))
    try {
      const binaryPath = join(dir, 'rg.exe')
      const archive = Buffer.from(
        zipSync({
          'ripgrep/rg.exe': new TextEncoder().encode('trusted binary'),
          'ripgrep/ignored.dll': new TextEncoder().encode('ignored'),
        }),
      )

      await postinstall.extractZip(archive, binaryPath, 'rg.exe')

      expect(await readFile(binaryPath, 'utf-8')).toBe('trusted binary')
      expect(existsSync(join(dir, 'ignored.dll'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('TAR.GZ extraction writes only the single expected regular file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'postinstall-tar-'))
    try {
      const binaryPath = join(dir, 'rg')
      const archive = gzipSync(
        tarArchive([
          { name: 'ripgrep/rg', data: Buffer.from('trusted binary') },
          { name: 'ripgrep/README.md', data: Buffer.from('ignored') },
        ]),
      )

      await postinstall.extractTarGz(archive, binaryPath, 'rg')

      expect(await readFile(binaryPath, 'utf-8')).toBe('trusted binary')
      expect(existsSync(join(dir, 'README.md'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects traversal and duplicate binary entries', async () => {
    expect(postinstall.isExpectedArchiveEntry('../rg', 'rg')).toBe(false)
    const dir = await mkdtemp(join(tmpdir(), 'postinstall-duplicate-'))
    try {
      const archive = Buffer.from(
        zipSync({
          'a/rg.exe': new TextEncoder().encode('first'),
          'b/rg.exe': new TextEncoder().encode('second'),
        }),
      )
      await expect(
        postinstall.extractZip(archive, join(dir, 'rg.exe'), 'rg.exe'),
      ).rejects.toThrow(/Multiple rg\.exe entries/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
