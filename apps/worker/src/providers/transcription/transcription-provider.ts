import type { Transcript } from "@clipforge/shared";

/**
 * Astrazione sul provider di speech-to-text. Implementazione di default:
 * OpenAI Whisper API (vedi openai-whisper-provider.ts). Sostituibile con un provider
 * self-hosted (es. faster-whisper) implementando la stessa interfaccia.
 */
export interface TranscriptionProvider {
  /** Trascrive un file audio locale e ritorna un Transcript con timestamp a livello di parola. */
  transcribe(audioFilePath: string): Promise<Transcript>;
}
