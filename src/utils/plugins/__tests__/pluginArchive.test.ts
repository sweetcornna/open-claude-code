import { afterEach, describe, expect, test } from 'bun:test'
import { zipSync } from 'fflate'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertAllowedArchiveUrl,
  extractPluginArchive,
  findExtractedPluginRoot,
  isPluginArchiveRef,
  isRemotePluginRef,
  materializePluginRef,
  PLUGIN_ARCHIVE_LIMITS,
  PluginArchiveError,
  resolveArchiveEntryPath,
} from '../pluginArchive.js'

/**
 * `--plugin-url` fetches code and loads it into the session. These are the
 * three guards that make that acceptable, tested by constructing the attack —
 * a message assertion would keep passing after the guard was removed.
 */

const tmpDirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'occ-plugin-archive-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

const enc = (s: string) => new TextEncoder().encode(s)

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, enc(v)])),
  )
}

const MANIFEST = JSON.stringify({ name: 'demo', version: '1.0.0' })

describe('zip slip', () => {
  test('rejects an archive whose entry escapes with ../..', async () => {
    const target = join(scratch(), 'extract')
    const victimRoot = scratch()
    const victim = join(victimRoot, 'pwned.txt')

    // fflate stores the name verbatim, so this is a genuine traversal entry.
    const malicious = zipSync({
      '.claude-plugin/plugin.json': enc(MANIFEST),
      '../../pwned.txt': enc('owned'),
    })

    await expect(extractPluginArchive(malicious, target)).rejects.toThrow(
      PluginArchiveError,
    )
    expect(existsSync(victim)).toBe(false)
    // Nothing is written until every entry validates.
    expect(existsSync(join(target, '.claude-plugin', 'plugin.json'))).toBe(
      false,
    )
  })

  test('rejects a single leading ../ entry', async () => {
    const target = join(scratch(), 'extract')
    await expect(
      extractPluginArchive(zip({ '../escape.txt': 'x' }), target),
    ).rejects.toThrow(PluginArchiveError)
  })

  test.each([
    ['/etc/passwd', 'absolute path'],
    ['//host/share/evil', 'UNC path'],
    ['C:\\Windows\\System32\\evil', 'drive-absolute path'],
    ['..\\..\\windows-traversal', 'path traversal'],
    ['ok/../../escape', 'path traversal'],
    ['', 'empty path'],
  ])('resolveArchiveEntryPath refuses %p', (entry, why) => {
    expect(() => resolveArchiveEntryPath('/tmp/target', entry)).toThrow(why)
  })

  test('resolveArchiveEntryPath keeps ordinary nested paths', () => {
    const resolved = resolveArchiveEntryPath('/tmp/target', 'skills/a/SKILL.md')
    expect(resolved).toBe('/tmp/target/skills/a/SKILL.md')
  })

  test('a name that merely starts with the root prefix does not escape', () => {
    // "/tmp/target-evil" shares a string prefix with "/tmp/target" but is a
    // sibling — a naive startsWith() containment check would let it through.
    expect(() =>
      resolveArchiveEntryPath('/tmp/target', '../target-evil/x'),
    ).toThrow(PluginArchiveError)
  })
})

describe('source validation', () => {
  test.each([
    'http://example.com/plugin.zip',
    'ftp://example.com/plugin.zip',
    'file:///etc/plugin.zip',
  ])('refuses non-https %p', ref => {
    expect(() => assertAllowedArchiveUrl(ref)).toThrow(PluginArchiveError)
  })

  test('refuses credentials embedded in the URL', () => {
    expect(() =>
      assertAllowedArchiveUrl('https://user:pass@example.com/plugin.zip'),
    ).toThrow(/must not embed credentials/)
  })

  test('refuses a URL that does not point at a .zip', () => {
    expect(() => assertAllowedArchiveUrl('https://example.com/plugin')).toThrow(
      /must point at a .zip/,
    )
  })

  test('accepts an https .zip, including with a query string', () => {
    expect(
      assertAllowedArchiveUrl('https://example.com/p.zip?sig=abc').hostname,
    ).toBe('example.com')
  })

  test('a remote reference that is not a zip is refused before any fetch', async () => {
    await expect(
      materializePluginRef('https://example.com/plugin'),
    ).rejects.toThrow(/must be a .zip archive/)
  })
})

describe('size limits', () => {
  test('refuses an archive with more entries than the cap', async () => {
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i <= PLUGIN_ARCHIVE_LIMITS.maxEntries; i++) {
      files[`f${i}.txt`] = enc('x')
    }
    await expect(
      extractPluginArchive(zipSync(files), join(scratch(), 'out')),
    ).rejects.toThrow(/too many entries/)
  })

  test('refuses a zip bomb', async () => {
    // Small on the wire (well under the download cap), 320MB on disk — past
    // the 128MB uncompressed cap. Two guards can catch this: fflate's
    // compression-ratio check inside unzipFile, and this module's total-bytes
    // cap. Which one fires depends on the archive's ratio, so assert the
    // property that matters — the bomb is refused and nothing is written.
    const target = join(scratch(), 'out')
    const bomb = zipSync(
      Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          `big${i}.bin`,
          new Uint8Array(8 * 1024 * 1024),
        ]),
      ),
      { level: 9 },
    )
    expect(bomb.byteLength).toBeLessThan(PLUGIN_ARCHIVE_LIMITS.maxDownloadBytes)
    await expect(extractPluginArchive(bomb, target)).rejects.toThrow(
      PluginArchiveError,
    )
    expect(existsSync(target)).toBe(false)
  })

  test('refuses bytes larger than the download cap outright', async () => {
    const oversized = new Uint8Array(PLUGIN_ARCHIVE_LIMITS.maxDownloadBytes + 1)
    await expect(
      extractPluginArchive(oversized, join(scratch(), 'out')),
    ).rejects.toThrow(/too large/)
  })
})

describe('extraction', () => {
  test('writes a well-formed plugin and finds its root', async () => {
    const target = join(scratch(), 'out')
    await extractPluginArchive(
      zip({
        '.claude-plugin/plugin.json': MANIFEST,
        'skills/greeter/SKILL.md': '---\ndescription: hi\n---\n\nbody\n',
      }),
      target,
    )

    expect(
      readFileSync(join(target, '.claude-plugin/plugin.json'), 'utf8'),
    ).toBe(MANIFEST)
    expect(await findExtractedPluginRoot(target)).toBe(target)
  })

  test('unwraps the single top-level directory GitHub zips add', async () => {
    const target = join(scratch(), 'out')
    await extractPluginArchive(
      zip({
        'my-plugin-main/.claude-plugin/plugin.json': MANIFEST,
        'my-plugin-main/skills/a/SKILL.md': 'x',
      }),
      target,
    )
    expect(await findExtractedPluginRoot(target)).toBe(
      join(target, 'my-plugin-main'),
    )
  })

  test('refuses an archive with no plugin manifest', async () => {
    const target = join(scratch(), 'out')
    await extractPluginArchive(zip({ 'README.md': 'not a plugin' }), target)
    await expect(findExtractedPluginRoot(target)).rejects.toThrow(
      /does not contain a plugin/,
    )
  })

  test('extracted files are not executable', async () => {
    const target = join(scratch(), 'out')
    await extractPluginArchive(zip({ 'hooks/run.sh': '#!/bin/sh\n' }), target)
    const { statSync } = await import('fs')
    expect(statSync(join(target, 'hooks/run.sh')).mode & 0o111).toBe(0)
  })
})

describe('reference classification', () => {
  test.each([
    ['plugin.zip', true],
    ['/abs/path/plugin.ZIP', true],
    ['https://example.com/p.zip?x=1', true],
    ['/abs/path/plugin-dir', false],
    ['https://example.com/p.tar.gz', false],
  ])('isPluginArchiveRef(%p) === %p', (ref, expected) => {
    expect(isPluginArchiveRef(ref)).toBe(expected)
  })

  test.each([
    ['https://example.com/p.zip', true],
    ['/local/dir', false],
    ['./relative', false],
    ['C:\\plugins\\dir', false],
  ])('isRemotePluginRef(%p) === %p', (ref, expected) => {
    expect(isRemotePluginRef(ref)).toBe(expected)
  })

  test('a plain directory reference passes through unchanged', async () => {
    const dir = scratch()
    expect(await materializePluginRef(dir)).toBe(dir)
  })
})
