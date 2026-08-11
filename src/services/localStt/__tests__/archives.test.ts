/**
 * Regression tests for the self-contained archive readers.
 *
 * These exist because the local-STT install refuses to shell out to `tar`
 * (see the comment at the top of bzip2.ts). The fixtures below were
 * produced by the system `bzip2`/`tar` and embedded as base64 so the suite
 * runs identically on a machine that has neither.
 */

import { describe, expect, test } from 'bun:test'
import { bunzip2, Bzip2Error } from '../bzip2.js'
import { readTar, TarError } from '../tar.js'
import {
  isWantedRuntimeEntry,
  selectRuntimeFiles,
  stripArchiveRoot,
} from '../install.js'

// `printf 'hello world\n' | bzip2 -9`
const HELLO_BZ2 =
  'QlpoOTFBWSZTWU7s6DYAAAJRgAAQQAAGRJCAIAAxBkxBAaeppYC7lDH4u5IpwoSCd2dBsA=='
// 100000 copies of 'a' — exercises the RLE1 path that RLE2 alone cannot.
const REPEAT_BZ2 =
  'QlpoOTFBWSZTWUNR2fUAAMYRAIQAIAAACCAAMMwFKacYQtgQvF3JFOFCQQ1HZ9Q='
const EMPTY_BZ2 = 'QlpoORdyRThQkAAAAAA='
// A miniature stand-in for a sherpa-onnx release archive: versioned root
// directory, the executable occ wants, another executable it does not,
// two shared libraries and a symlink between them.
const TAR_BZ2 =
  'QlpoOTFBWSZTWYHeEoQAAtz/kdOQAYx8A/+wNiaUAH/v3+AEAAEABYhAAc4Ym7QkpTQAaGmmQMgAGgAAABJSY0mpMmQADBNGhpoxMRoYANqpqGmgBoANADQAAZADQKlESNPFBkj1A9CZDT1GnqMmjymNCMmNBsQZVERPJp9FpOIPwpV4ZGVKeIQEmFkNxjTkxS4hrhUhgQydVhHChfCkNyKlkXQzTm5rN5biNWV77PGjq8PbCjITuhohdC2FzBvMSFNVtdPF2d00USyWTPHuJEyw54UQ+ua/R9NOd0Y4XIUhePhTcWx6YUSK4QZj2ZBJA+JbKQuIHIiz5oIxKXcU0DSaF1DkRKJqDRQOCaCTn0BKhA7BVJvqIZBTMRImPQRQSaD0KFUQaUFTOduMyZIfGXPTmwTd+dWNt7Y5YbInP2fzTDrh0DAoW7XrhsrDp9hgtfvZWV10hhDHCkTdh8uvg3+lHhCkTU71BWJq3A0OtoPQVkZ2Dbz7nNxKOgYVKqBiStCXr2NgWGhKOgdGVhJwQ6hSqrBJglTEdpmhw3wyYWP7c/1PPzVvhlhnQvhlm7CsKREGtqMJRCTYFlLIAv4u5IpwoSEDvCUI'

function decode(base64: string): Buffer {
  return Buffer.from(base64, 'base64')
}

describe('bunzip2', () => {
  test('decodes a short stream', () => {
    expect(bunzip2(decode(HELLO_BZ2)).toString()).toBe('hello world\n')
  })

  test('decodes a run-length-heavy stream', () => {
    const out = bunzip2(decode(REPEAT_BZ2))
    expect(out.length).toBe(100000)
    expect(out.every(byte => byte === 0x61)).toBe(true)
  })

  test('decodes an empty stream', () => {
    expect(bunzip2(decode(EMPTY_BZ2)).length).toBe(0)
  })

  test('rejects a non-bzip2 buffer instead of returning garbage', () => {
    expect(() => bunzip2(Buffer.from('not an archive at all'))).toThrow(
      Bzip2Error,
    )
  })

  test('rejects truncated input', () => {
    const full = decode(HELLO_BZ2)
    expect(() => bunzip2(full.subarray(0, full.length - 6))).toThrow(Bzip2Error)
  })

  test('rejects a corrupted block', () => {
    const corrupted = decode(REPEAT_BZ2)
    corrupted[20] = corrupted[20]! ^ 0xff
    expect(() => bunzip2(corrupted)).toThrow(Bzip2Error)
  })
})

describe('readTar', () => {
  const entries = readTar(bunzip2(decode(TAR_BZ2)))

  test('reads regular files with their contents and modes', () => {
    const exe = entries.find(entry =>
      entry.name.endsWith('bin/sherpa-onnx-offline'),
    )
    expect(exe).toBeDefined()
    expect(exe!.type).toBe('file')
    expect(Buffer.from(exe!.data).toString()).toBe(
      '#!/bin/sh\necho fake sherpa\n',
    )
  })

  test('reads symlinks with their targets rather than dropping them', () => {
    const link = entries.find(entry =>
      entry.name.endsWith('lib/libonnxruntime.dylib'),
    )
    expect(link?.type).toBe('symlink')
    expect(link?.linkTarget).toBe('libonnxruntime.1.17.1.dylib')
  })

  test('stops at the end-of-archive marker without throwing', () => {
    expect(entries.length).toBeGreaterThan(4)
    expect(entries.every(entry => entry.name.length > 0)).toBe(true)
  })

  test('rejects an entry whose payload runs past the buffer', () => {
    const header = Buffer.alloc(512)
    header.write('big.bin', 0)
    header.write('00000001000\0', 124) // 32768 octal bytes, nothing follows
    header[156] = 0x30 // typeflag '0'
    expect(() => readTar(header)).toThrow(TarError)
  })
})

describe('runtime file selection', () => {
  test('keeps only the recognizer and shared libraries', () => {
    expect(isWantedRuntimeEntry('bin/sherpa-onnx-offline')).toBe(true)
    expect(isWantedRuntimeEntry('bin/sherpa-onnx-offline.exe')).toBe(true)
    expect(isWantedRuntimeEntry('lib/libonnxruntime.so.1.17.1')).toBe(true)
    expect(isWantedRuntimeEntry('lib/libsherpa-onnx-c-api.dylib')).toBe(true)
    expect(isWantedRuntimeEntry('bin/onnxruntime.dll')).toBe(true)
    // The archives carry ~40 other tools; keeping them triples disk use.
    expect(isWantedRuntimeEntry('bin/sherpa-onnx-online')).toBe(false)
    expect(isWantedRuntimeEntry('include/sherpa-onnx/c-api/c-api.h')).toBe(
      false,
    )
  })

  test('strips the versioned root directory only when shared by all', () => {
    expect(stripArchiveRoot(['root/a', 'root/b'])).toBe('root/')
    expect(stripArchiveRoot(['root/a', 'other/b'])).toBe('')
    expect(stripArchiveRoot([])).toBe('')
  })

  test('materialises symlinked libraries as copies', () => {
    const { files, executable } = selectRuntimeFiles(
      readTar(bunzip2(decode(TAR_BZ2))),
    )
    expect(executable).toBe('bin/sherpa-onnx-offline')

    const names = files.map(file => file.name).sort()
    expect(names).toEqual([
      'bin/sherpa-onnx-offline',
      'lib/libonnxruntime.1.17.1.dylib',
      'lib/libonnxruntime.dylib',
      'lib/libsherpa-onnx-c-api.dylib',
    ])

    // The symlink must arrive as real bytes: Windows cannot create one
    // without Developer Mode, and the executable will not load without it.
    const linked = files.find(file => file.name === 'lib/libonnxruntime.dylib')!
    expect(Buffer.from(linked.data).toString()).toBe('ORTDATA')
    expect(
      files.find(file => file.name === 'bin/sherpa-onnx-offline')!.mode,
    ).toBe(0o755)
  })

  test('drops entries that try to escape the install directory', () => {
    const { files } = selectRuntimeFiles([
      {
        name: 'root/bin/sherpa-onnx-offline',
        type: 'file',
        mode: 0o755,
        data: new Uint8Array([1]),
        linkTarget: '',
      },
      {
        name: 'root/../../evil.dylib',
        type: 'file',
        mode: 0o644,
        data: new Uint8Array([2]),
        linkTarget: '',
      },
    ])
    expect(files.map(file => file.name)).toEqual(['bin/sherpa-onnx-offline'])
  })
})
