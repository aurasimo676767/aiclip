import type { TranscriptSegment } from "@clipforge/shared";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";

/** Finestra di misura del volume: 50ms, abbastanza fine da seguire una singola parola. */
const WINDOW_SECONDS = 0.05;
const SAMPLE_RATE = 8000;
/**
 * Quanto parlato attorno alla clip si usa come riferimento del "parlare normale". Non la clip
 * stessa: misurato su una clip urlata dall'inizio alla fine, dentro la clip lo scarto massimo era
 * +2dB — il riferimento era già un urlo, e nessuna parola risultava più forte delle altre.
 */
const CONTEXT_SECONDS = 45;

/**
 * Annota ogni parola della clip con `loudnessDb`: di quanti dB supera il livello ABITUALE della
 * voce nel parlato attorno alla clip. Il riferimento è la mediana dei picchi delle PAROLE (non del
 * volume medio dell'audio): negli stream il gioco fa rumore anche quando nessuno parla, e contarlo
 * abbasserebbe il riferimento facendo sembrare urlata ogni frase normale.
 *
 * Ritorna i segmenti con le parole annotate (copie, gli originali non vengono toccati). Se
 * l'analisi fallisce ritorna i segmenti così come sono: i sottotitoli restano senza evidenza sulle
 * urla, il render non si ferma per questo.
 */
export async function annotateWordLoudness(
  sourcePath: string,
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
): Promise<TranscriptSegment[]> {
  const windowStart = Math.max(0, clipStart - CONTEXT_SECONDS);
  const windowEnd = clipEnd + CONTEXT_SECONDS;

  let levels: number[];
  try {
    levels = await measureRmsWindows(sourcePath, windowStart, windowEnd - windowStart);
  } catch (err) {
    logger.warn("Misura del volume per parola fallita, sottotitoli senza evidenza sulle urla", {
      error: err instanceof Error ? err.message : String(err),
    });
    return segments;
  }
  if (levels.length === 0) return segments;

  const peakOf = (start: number, end: number) => {
    const from = Math.max(0, Math.floor((start - windowStart) / WINDOW_SECONDS));
    const to = Math.min(levels.length - 1, Math.ceil((end - windowStart) / WINDOW_SECONDS));
    let peak = -100;
    for (let i = from; i <= to; i++) peak = Math.max(peak, levels[i]!);
    return peak;
  };

  const contextPeaks = segments
    .flatMap((s) => s.words)
    .filter((w) => w.start >= windowStart && w.end <= windowEnd)
    .map((w) => peakOf(w.start, w.end))
    .filter((p) => p > -90);
  if (contextPeaks.length < 8) return segments;
  const baseline = median(contextPeaks);

  return segments.map((seg) =>
    seg.end < clipStart || seg.start > clipEnd
      ? seg
      : {
          ...seg,
          words: seg.words.map((w) => (w.start >= clipStart && w.start < clipEnd ? { ...w, loudnessDb: peakOf(w.start, w.end) - baseline } : w)),
        },
  );
}

async function measureRmsWindows(mediaPath: string, start: number, duration: number): Promise<number[]> {
  const samplesPerWindow = Math.round(SAMPLE_RATE * WINDOW_SECONDS);
  const { stdout } = await runFfmpeg([
    "-hide_banner",
    "-ss",
    String(start),
    "-t",
    String(duration),
    "-i",
    mediaPath,
    "-map",
    "0:a:0",
    "-af",
    `aresample=${SAMPLE_RATE},asetnsamples=n=${samplesPerWindow},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
    "-f",
    "null",
    "-",
  ]);
  const levels: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[0-9.]+|-inf)/);
    if (!match?.[1]) continue;
    const db = match[1] === "-inf" ? -100 : Number(match[1]);
    levels.push(Number.isFinite(db) ? db : -100);
  }
  return levels;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
