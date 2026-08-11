/**
 * Minimal RIFF/WAVE writer.
 *
 * voice.ts already captures exactly what the recognizer wants — 16 kHz,
 * 16-bit signed little-endian, mono — but emits it as headerless PCM
 * (`-t raw` for SoX, `-t raw` for arecord, raw callback buffers for the
 * native module). `sherpa-onnx-offline` only reads files, and only
 * container formats it can parse, so the single missing piece is a 44-byte
 * canonical header. No resampling, no format conversion.
 */

const RIFF_HEADER_BYTES = 44

const WAV_SAMPLE_RATE = 16000
const WAV_CHANNELS = 1
const WAV_BITS_PER_SAMPLE = 16

/**
 * Wrap signed 16-bit little-endian mono PCM in a canonical 44-byte WAVE
 * header. `pcm` is not copied into an intermediate buffer beyond the single
 * concat below — a 60s recording is ~1.9MB, and the buffer is released as
 * soon as the temp file is written.
 */
export function encodeWav(
  pcm: Uint8Array,
  sampleRate: number = WAV_SAMPLE_RATE,
): Buffer {
  const header = Buffer.alloc(RIFF_HEADER_BYTES)
  const byteRate = (sampleRate * WAV_CHANNELS * WAV_BITS_PER_SAMPLE) / 8
  const blockAlign = (WAV_CHANNELS * WAV_BITS_PER_SAMPLE) / 8

  header.write('RIFF', 0, 'ascii')
  // RIFF chunk size = everything after this field.
  header.writeUInt32LE(36 + pcm.byteLength, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM fmt chunk size
  header.writeUInt16LE(1, 20) // audio format 1 = PCM
  header.writeUInt16LE(WAV_CHANNELS, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(WAV_BITS_PER_SAMPLE, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.byteLength, 40)

  return Buffer.concat([header, pcm])
}

/** Duration in seconds of a 16-bit mono PCM buffer. */
function pcmDurationSeconds(
  byteLength: number,
  sampleRate: number = WAV_SAMPLE_RATE,
): number {
  return byteLength / 2 / sampleRate
}
