import type { TranscriptWord } from "@clipforge/shared";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";
import { measureRmsWindows, WINDOW_SECONDS } from "./word-loudness.js";

export interface SilenceInterval {
  start: number;
  end: number;
}

export interface TimeSegment {
  start: number;
  end: number;
}

/**
 * Rileva i silenzi in un file audio/video usando il filtro `silencedetect` di ffmpeg.
 * ffmpeg scrive gli eventi silence_start/silence_end su stderr: li eseguiamo con output
 * su null device e parsiamo il testo.
 */
export async function detectSilences(
  filePath: string,
  options: { noiseThresholdDb?: number; minDurationSeconds?: number } = {},
): Promise<SilenceInterval[]> {
  const noiseThresholdDb = options.noiseThresholdDb ?? -35;
  const minDurationSeconds = options.minDurationSeconds ?? 0.5;

  let stderr: string;
  try {
    const result = await runFfmpeg([
      "-i",
      filePath,
      "-af",
      `silencedetect=noise=${noiseThresholdDb}dB:d=${minDurationSeconds}`,
      "-f",
      "null",
      "-",
    ]);
    stderr = result.stderr;
  } catch (err) {
    // ffmpeg con -f null e nessun output reale può comunque uscire con stderr popolato
    // e codice 0 nella maggior parte dei casi; se lancia comunque, recuperiamo lo stderr dall'errore.
    const stderrFromError = (err as { stderr?: string }).stderr;
    if (!stderrFromError) throw err;
    stderr = stderrFromError;
  }

  const silences: SilenceInterval[] = [];
  const startMatches = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)];
  const endMatches = [...stderr.matchAll(/silence_end:\s*(-?[\d.]+)/g)];

  for (let i = 0; i < startMatches.length; i++) {
    const startStr = startMatches[i]?.[1];
    const endStr = endMatches[i]?.[1];
    if (!startStr || !endStr) continue;
    const start = Number.parseFloat(startStr);
    const end = Number.parseFloat(endStr);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      silences.push({ start, end });
    }
  }

  return silences;
}

/**
 * Dati i silenzi rilevati, calcola i segmenti da MANTENERE nel video finale.
 * Ogni silenzio viene "tagliato" solo per l'eccesso oltre `paddingSeconds` (per non
 * rendere il parlato innaturalmente compresso), e solo se supera `minDurationSeconds`.
 */
export function computeKeepSegments(
  totalDuration: number,
  silences: SilenceInterval[],
  options: { minDurationToCutSeconds?: number; paddingSeconds?: number } = {},
): TimeSegment[] {
  const minDurationToCutSeconds = options.minDurationToCutSeconds ?? 0.6;
  const paddingSeconds = options.paddingSeconds ?? 0.15;

  const cuts = silences
    .filter((s) => s.end - s.start >= minDurationToCutSeconds)
    .map((s) => ({ start: s.start + paddingSeconds, end: s.end - paddingSeconds }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const keep: TimeSegment[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) {
      keep.push({ start: cursor, end: Math.min(cut.start, totalDuration) });
    }
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < totalDuration) {
    keep.push({ start: cursor, end: totalDuration });
  }

  return keep.filter((s) => s.end - s.start > 0.05);
}

/**
 * Costruisce una funzione che rimappa un timestamp nella timeline originale al timestamp
 * corrispondente nella timeline "tagliata" (dopo la rimozione dei segmenti di silenzio).
 * I timestamp che cadono dentro un segmento rimosso vengono agganciati al bordo più vicino
 * del segmento mantenuto successivo, per mantenere sincronizzati captions ed EDL.
 */
export function buildTimeRemap(keepSegments: TimeSegment[]): (originalTime: number) => number {
  if (keepSegments.length === 0) {
    return (t) => t;
  }

  const cumulative: Array<{ start: number; end: number; newStart: number }> = [];
  let acc = 0;
  for (const seg of keepSegments) {
    cumulative.push({ start: seg.start, end: seg.end, newStart: acc });
    acc += seg.end - seg.start;
  }

  return (originalTime: number): number => {
    for (const seg of cumulative) {
      if (originalTime < seg.start) {
        return seg.newStart;
      }
      if (originalTime <= seg.end) {
        return seg.newStart + (originalTime - seg.start);
      }
    }
    const last = cumulative[cumulative.length - 1];
    return last ? last.newStart + (last.end - last.start) : originalTime;
  };
}

/**
 * Quanto il livello di un buco nel parlato deve stare sotto la voce per essere "tempo morto".
 * Una risata o un urlo senza parole (Whisper non li trascrive) sono forti quanto la voce e restano;
 * il gioco in sottofondo, i passi, il ventilatore stanno molto più in basso e si tagliano.
 */
const QUIET_BELOW_SPEECH_DB = 8;

/**
 * Buchi nel PARLATO, non nell'audio: tratti fra due parole più lunghi di `minGapSeconds` in cui
 * l'audio sta chiaramente sotto il livello della voce.
 *
 * Perché serve: `detectSilences` cerca il silenzio dell'audio, ma negli stream il gioco fa rumore
 * anche quando nessuno parla, quindi quei tempi morti non risultavano mai "silenzio" e restavano
 * dentro lo Short. I tempi delle parole invece dicono esattamente quando qualcuno parla.
 *
 * `words` in tempi relativi a `mediaPath` (0 = inizio del file).
 */
export async function detectQuietSpeechGaps(mediaPath: string, words: TranscriptWord[], minGapSeconds: number): Promise<SilenceInterval[]> {
  const sorted = [...words].filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  if (sorted.length < 3) return [];
  const duration = sorted[sorted.length - 1]!.end + 1;

  let levels: number[];
  try {
    levels = await measureRmsWindows(mediaPath, 0, duration);
  } catch (err) {
    logger.warn("Misura dei buchi nel parlato fallita, resta solo il taglio dei silenzi audio", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  const windowsIn = (start: number, end: number) =>
    levels.slice(Math.max(0, Math.floor(start / WINDOW_SECONDS)), Math.max(0, Math.ceil(end / WINDOW_SECONDS)));

  const speechPeaks = sorted.map((w) => Math.max(-100, ...windowsIn(w.start, w.end))).filter((p) => p > -90);
  if (speechPeaks.length < 3) return [];
  const speech = [...speechPeaks].sort((a, b) => a - b)[Math.floor(speechPeaks.length / 2)]!;

  const gaps: SilenceInterval[] = [];
  let lastEnd = sorted[0]!.end;
  for (const w of sorted.slice(1)) {
    if (w.start - lastEnd >= minGapSeconds) {
      const inside = windowsIn(lastEnd, w.start).sort((a, b) => a - b);
      // L'80° percentile e non il massimo: un colpo isolato (un tasto, un click) non deve salvare
      // un buco di due secondi.
      const loud = inside[Math.floor(inside.length * 0.8)] ?? -100;
      if (loud <= speech - QUIET_BELOW_SPEECH_DB) gaps.push({ start: lastEnd, end: w.start });
    }
    lastEnd = Math.max(lastEnd, w.end);
  }
  return gaps;
}

/** Unisce intervalli sovrapposti (silenzi audio + buchi nel parlato). */
export function mergeIntervals(intervals: SilenceInterval[]): SilenceInterval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: SilenceInterval[] = [];
  for (const i of sorted) {
    const last = merged[merged.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else merged.push({ ...i });
  }
  return merged;
}
