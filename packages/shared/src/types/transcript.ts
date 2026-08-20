/** Singola parola trascritta con timestamp a livello di parola (secondi, dall'inizio del video). */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  /** Confidenza del provider STT, 0-1, se disponibile. */
  confidence?: number;
}

/** Segmento di trascrizione (tipicamente una frase o unità di parlato continuo). */
export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
  /**
   * Etichetta dello speaker se disponibile (es. "speaker_1").
   * In Fase 1 può essere assente: nessuna diarizzazione avanzata garantita.
   */
  speaker?: string;
}

export interface Transcript {
  language: string;
  durationSeconds: number;
  fullText: string;
  segments: TranscriptSegment[];
  /** Nome del provider che ha generato la trascrizione, es. "openai-whisper". */
  provider: string;
}
