// Local (offline) speech-to-text adapter for voice mode.
//
// Presents the same send/finalize/close surface as voiceStreamSTT.ts so
// useVoice.ts needs no special casing beyond picking the connect function.
// Unlike the other two backends this one is not streaming: sherpa-onnx
// runs a single pass over the finished utterance, so send() accumulates
// PCM and finalize() is where recognition actually happens. useVoice
// already shows a 'processing' state between key release and transcript,
// which is exactly the window this occupies.

import type {
  FinalizeSource,
  VoiceStreamCallbacks,
  VoiceStreamConnection,
} from './voiceStreamSTT.js'
import {
  DEFAULT_LOCAL_STT_MODEL_ID,
  type LocalSttModel,
  resolveLocalSttModel,
} from './localStt/catalog.js'
import { checkLocalSttReadiness } from './localStt/install.js'
import { transcribePcm } from './localStt/transcribe.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { logForDebugging } from '../utils/telemetry/debug.js'
import { logError } from '../utils/telemetry/log.js'
import { toError } from '../utils/runtime/errors.js'

// Re-exported so useVoice can import the type from whichever backend module
// it is already touching, matching doubaoSTT.ts.

/**
 * Hard cap on buffered audio: 5 minutes at 16 kHz / 16-bit / mono. A
 * hold-to-talk utterance is seconds long; this only bounds the damage when
 * a key-release event is lost and recording never stops.
 */
const MAX_PCM_BYTES = 5 * 60 * 16000 * 2

/**
 * Which model this session will use, from settings.
 *
 * The feature-gated spread in settings/types.ts widens these keys to `{}`
 * in the inferred settings type, so narrow with a typeof guard rather than
 * asserting — an unset or garbage value falls back to the default.
 */
export function currentLocalSttModel(): LocalSttModel {
  const configured: unknown = getInitialSettings().voiceLocalModel
  return resolveLocalSttModel(
    typeof configured === 'string' ? configured : DEFAULT_LOCAL_STT_MODEL_ID,
  )
}

export async function connectLocalSttStream(
  callbacks: VoiceStreamCallbacks,
  options?: { language?: string },
): Promise<VoiceStreamConnection | null> {
  const model = currentLocalSttModel()
  const readiness = checkLocalSttReadiness(model)
  if (!readiness.ready) {
    // Fatal: retrying the connection cannot install a 237MB model. The
    // reason string already names what is missing and how to get it.
    callbacks.onError(readiness.reason, { fatal: true })
    return null
  }

  const chunks: Buffer[] = []
  let bufferedBytes = 0
  let finalized = false
  let closed = false

  const connection: VoiceStreamConnection = {
    send(audioChunk: Buffer): void {
      if (finalized || closed) return
      if (bufferedBytes + audioChunk.byteLength > MAX_PCM_BYTES) return
      chunks.push(audioChunk)
      bufferedBytes += audioChunk.byteLength
    },
    async finalize(): Promise<FinalizeSource> {
      if (finalized) return 'ws_already_closed'
      finalized = true
      if (bufferedBytes === 0) {
        return 'no_data_timeout'
      }
      const pcm = Buffer.concat(chunks)
      // Release the per-chunk references before the recognizer starts:
      // the concat above already doubled the peak, and the child process
      // is about to become the memory-hungry party.
      chunks.length = 0
      try {
        const text = await transcribePcm(pcm, {
          executable: readiness.executable,
          modelDir: readiness.modelDir,
          model,
          language: options?.language,
        })
        if (closed) return 'ws_close'
        if (text) {
          callbacks.onTranscript(text, true)
          return 'post_closestream_endpoint'
        }
        return 'no_data_timeout'
      } catch (error) {
        const err = toError(error)
        logError(err)
        if (!closed) callbacks.onError(err.message)
        return 'ws_close'
      }
    },
    close(): void {
      closed = true
      finalized = true
      chunks.length = 0
      bufferedBytes = 0
      callbacks.onClose()
    },
    isConnected(): boolean {
      return !closed
    },
  }

  logForDebugging(`[local-stt] ready with model ${model.id}`)
  callbacks.onReady(connection)
  return connection
}
