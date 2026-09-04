import type { Transcript } from "@clipforge/shared";

/**
 * Astrazione sul provider di speech-to-text. Implementazione di default:
 * OpenAI Whisper API (vedi openai-whisper-provider.ts). Sostituibile con un provider
 * self-hosted (es. faster-whisper) implementando la stessa interfaccia.
 */
export interface TranscribeOptions {
  /**
   * SOLO per la pipeline long-form/VOD, che non legge mai `words` né mostra sottotitoli: se
   * true, i provider che lo supportano possono usare un percorso più veloce (es. inferenza
   * batched) a costo di timestamp per parola assenti (`words: []`) e testo leggermente meno
   * preciso nei dettagli. Gli Shorts NON devono mai passare true — servono sia i timestamp
   * per parola (sottotitoli) sia la massima precisione sull'inizio della frase-gancio.
   * Provider senza un percorso più veloce (es. OpenAIWhisperProvider) lo ignorano.
   */
  fast?: boolean;
}

export interface TranscriptionProvider {
  /** Trascrive un file audio locale e ritorna un Transcript con timestamp a livello di parola. */
  transcribe(audioFilePath: string, options?: TranscribeOptions): Promise<Transcript>;
  /**
   * Controllo preventivo opzionale, da chiamare PRIMA di iniziare download/estrazione audio:
   * se lancia un errore, la pipeline fallisce subito invece che dopo ore di lavoro (es. un
   * download di più ore su un VOD Twitch) per poi scoprire che il server di trascrizione era
   * spento. Implementato solo dai provider dove ha senso (es. il server locale, che può
   * essere spento) — l'API OpenAI a pagamento non lo implementa, si assume sempre raggiungibile.
   */
  checkReady?(): Promise<void>;
}
