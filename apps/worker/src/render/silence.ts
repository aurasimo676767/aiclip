import { runFfmpeg } from "../lib/ffmpeg.js";

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
