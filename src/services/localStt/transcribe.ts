/**
 * Runs recognition in a child process.
 *
 * This is not an implementation detail. occ's resident set is ~35MB after
 * the code-splitting work documented in docs/zh/features/memory-footprint.md
 * (it was ~1GB before), and an ONNX session for the default model holds
 * roughly a quarter of a gigabyte of weights. Loading that in-process would
 * undo the whole exercise for every session that ever pressed the voice
 * key. `sherpa-onnx-offline` is a separate executable: the model is mapped
 * when the process starts and gone when it exits, and nothing survives in
 * occ's heap but the transcript string.
 *
 * The spawn is injected so the whole path is testable without the binary.
 */

import { spawn } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BIN_NAME } from '../../config/paths.js'
import { generateTempFilePath } from '../../utils/filesystem/tempfile.js'
import { logForDebugging } from '../../utils/telemetry/debug.js'
import type { LocalSttModel } from './catalog.js'
import { encodeWav } from './wav.js'

/** Narrow slice of ChildProcess this module needs; keeps fakes tiny. */
type TranscribeProcess = {
  stdout: { on: (event: 'data', cb: (chunk: Buffer) => void) => void } | null
  stderr: { on: (event: 'data', cb: (chunk: Buffer) => void) => void } | null
  on: {
    (event: 'close', cb: (code: number | null) => void): unknown
    (event: 'error', cb: (error: Error) => void): unknown
  }
}

type SpawnFn = (command: string, args: string[]) => TranscribeProcess

const defaultSpawn: SpawnFn = (command, args) =>
  spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as TranscribeProcess

/**
 * Threads the recognizer may use. Two keeps a laptop responsive while
 * dictating and, more importantly, keeps peak RSS predictable — ONNX
 * Runtime allocates per-thread arenas.
 */
const DEFAULT_THREADS = 2

type TranscribeOptions = {
  /** Absolute path to sherpa-onnx-offline. */
  executable: string
  /** Directory holding the model files named in `model.files`. */
  modelDir: string
  model: LocalSttModel
  /** BCP-47-ish code; only Whisper takes one. */
  language?: string
  numThreads?: number
}

/**
 * Build the recognizer's argv. The three model families take completely
 * different flags, which is the entire reason `LocalSttModel.kind` exists.
 * Exported for tests: getting a flag name wrong here surfaces as an opaque
 * "please provide a model" from a subprocess.
 */
function buildTranscribeArgs(
  options: TranscribeOptions,
  wavPath: string,
): string[] {
  const { model, modelDir } = options
  const file = (name: string): string => join(modelDir, name)
  const args = [
    `--tokens=${file(model.kind === 'whisper' ? 'tiny-tokens.txt' : 'tokens.txt')}`,
    `--num-threads=${String(options.numThreads ?? DEFAULT_THREADS)}`,
    '--debug=0',
  ]
  if (model.kind === 'sense-voice') {
    args.push(`--sense-voice-model=${file('model.int8.onnx')}`)
    // Inverse text normalisation: digits as digits, punctuation restored.
    // Dictated text goes straight into a prompt, so "12" beats "十二".
    args.push('--sense-voice-use-itn=true')
  } else if (model.kind === 'paraformer') {
    args.push(`--paraformer=${file('model.int8.onnx')}`)
  } else {
    args.push(`--whisper-encoder=${file('tiny-encoder.int8.onnx')}`)
    args.push(`--whisper-decoder=${file('tiny-decoder.int8.onnx')}`)
    if (options.language) {
      args.push(`--whisper-language=${options.language}`)
    }
  }
  args.push(wavPath)
  return args
}

/** SenseVoice prefixes its text with `<|zh|><|NEUTRAL|>`-style tags. */
const TAG_RE = /<\|[^|]*\|>/g

/**
 * Pull the transcript out of the recognizer's stdout.
 *
 * sherpa-onnx-offline prints the input path, then a JSON object per
 * utterance, then a summary. Only the JSON matters, and only its `text`
 * field; everything else (timings, per-token alignments) is noise here.
 * Unparseable output yields an empty string rather than a guess — a
 * confident wrong transcript is worse than none.
 */
function parseTranscriptOutput(stdout: string): string {
  const parts: string[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { text?: unknown }).text === 'string'
      ) {
        const text = (parsed as { text: string }).text
          .replace(TAG_RE, '')
          .trim()
        if (text) parts.push(text)
      }
    } catch {
      // Not a transcript line; the recognizer also logs JSON-ish config.
    }
  }
  return parts.join(' ')
}

class TranscribeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranscribeError'
  }
}

/**
 * Transcribe raw 16 kHz / 16-bit / mono PCM — exactly what voice.ts
 * already produces from all three of its capture backends.
 *
 * The audio is written to a temp WAV because the recognizer reads files,
 * and unlinked in a finally block whether or not recognition succeeded.
 */
export async function transcribePcm(
  pcm: Uint8Array,
  options: TranscribeOptions,
  spawnFn: SpawnFn = defaultSpawn,
): Promise<string> {
  if (pcm.byteLength === 0) return ''

  const wavPath = generateTempFilePath(`${BIN_NAME}-voice`, '.wav')
  await writeFile(wavPath, encodeWav(pcm))
  const args = buildTranscribeArgs(options, wavPath)
  logForDebugging(
    `[local-stt] spawning ${options.executable} (${String(pcm.byteLength)} PCM bytes)`,
  )

  try {
    const { stdout, stderr, code } = await runProcess(
      spawnFn,
      options.executable,
      args,
    )
    if (code !== 0) {
      throw new TranscribeError(
        `本地识别进程退出码 ${String(code)}：${stderr.trim().split('\n').slice(-3).join(' ') || '无输出'}`,
      )
    }
    const text = parseTranscriptOutput(stdout)
    logForDebugging(
      `[local-stt] transcript (${String(text.length)} chars): "${text.slice(0, 120)}"`,
    )
    return text
  } finally {
    await unlink(wavPath).catch(() => {})
  }
}

function runProcess(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let child: TranscribeProcess
    try {
      child = spawnFn(command, args)
    } catch (error) {
      reject(
        new TranscribeError(
          `无法启动本地识别程序 ${command}：${String(error)}`,
        ),
      )
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', (error: Error) => {
      reject(
        new TranscribeError(
          `无法启动本地识别程序 ${command}：${error.message}`,
        ),
      )
    })
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, code })
    })
  })
}
