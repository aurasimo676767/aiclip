import { measureRmsWindows, WINDOW_SECONDS } from "./word-loudness.js";

export interface MutedRange {
  start: number;
  end: number;
}

/** Sotto questo livello non c'è nemmeno il rumore di fondo: è silenzio digitale, non qualcuno che tace. */
const DIGITAL_SILENCE_DB = -90;
/** Twitch muta a blocchi da 180 s; da un minuto in su un silenzio digitale non è mai parte della live. */
const MIN_MUTED_SECONDS = 60;
/** Il video riparte a un fotogramma-chiave, che può stare poco prima della fine del tratto muto. */
const RESUME_PADDING_SECONDS = 2;
/** Un pezzetto attaccato a un tratto muto (8 s e poi un salto di 3 minuti) si toglie anche lui. */
const MIN_PIECE_SECONDS = 30;

/**
 * Tratti senza audio di un intervallo del sorgente (secondi del sorgente). Twitch toglie per sempre
 * l'audio coperto da copyright: simo, 2026-10-30, "non ha audio all'inizio", 3 minuti muti in un
 * video pubblicato. Si guarda l'audio e non la lista di Twitch: vale anche quando il VOD è scaduto.
 */
export async function findMutedRanges(sourcePath: string, start: number, end: number): Promise<MutedRange[]> {
  const levels = await measureRmsWindows(sourcePath, start, end - start);
  const ranges: MutedRange[] = [];
  let runStart: number | null = null;
  for (let i = 0; i <= levels.length; i++) {
    const silent = i < levels.length && levels[i]! <= DIGITAL_SILENCE_DB;
    if (silent && runStart === null) runStart = i;
    if (!silent && runStart !== null) {
      if ((i - runStart) * WINDOW_SECONDS >= MIN_MUTED_SECONDS) {
        ranges.push({ start: start + runStart * WINDOW_SECONDS, end: start + i * WINDOW_SECONDS });
      }
      runStart = null;
    }
  }
  return ranges;
}

/** I pezzi di [start, end] da tenere togliendo i tratti muti. Vuoto = non resterebbe niente di utile. */
export function piecesWithoutMuted(start: number, end: number, muted: MutedRange[]): MutedRange[] {
  const pieces: MutedRange[] = [];
  let cursor = start;
  for (const range of muted) {
    pieces.push({ start: cursor, end: range.start });
    cursor = range.end + RESUME_PADDING_SECONDS;
  }
  pieces.push({ start: cursor, end });
  return pieces.filter((p) => p.end - p.start >= MIN_PIECE_SECONDS);
}
