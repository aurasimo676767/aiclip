import type { TranscriptSegment } from "@clipforge/shared";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";

export interface LoudMoment {
  start: number;
  end: number;
  /** Di quanti dB questo momento supera il livello vocale abituale del video. */
  aboveBaselineDb: number;
}

/** Quanto sopra il livello abituale deve stare un secondo per contare come "urlato". */
const SHOUT_THRESHOLD_DB = 5;
/** Un picco isolato di un secondo è spesso un rumore (un colpo, una notifica): serve continuità. */
const MIN_MOMENT_SECONDS = 1;
/** Due picchi separati da meno di così sono lo stesso momento concitato, non due eventi distinti. */
const MERGE_GAP_SECONDS = 3;
/** Oltre questo numero i "momenti forti" smettono di essere selettivi e diventano rumore nel prompt. */
const MAX_MOMENTS = 40;

/**
 * Trova i momenti in cui le voci si alzano nettamente rispetto al resto del video (urla, reazioni
 * concitate, risate forti). Il transcript dice COSA viene detto ma non COME: una battuta urlata e
 * una detta piano hanno lo stesso testo, mentre per uno Short la differenza è enorme — chi urla
 * tiene lo spettatore molto più a lungo. Questo passaggio recupera quel segnale, che l'AI da sola
 * (leggendo solo testo) non può vedere.
 *
 * Misura il livello RMS dell'audio secondo per secondo con ffmpeg, calcola il livello ABITUALE del
 * video (mediana) e considera "forte" ciò che lo supera di SHOUT_THRESHOLD_DB. La soglia è
 * relativa, non assoluta: un video registrato piano e uno registrato forte hanno picchi diversi in
 * dB assoluti, ma in entrambi ciò che conta è lo scarto dal proprio livello normale.
 */
export async function detectLoudMoments(mediaPath: string, segments: TranscriptSegment[]): Promise<LoudMoment[]> {
  let levels: Array<{ time: number; db: number }>;
  try {
    levels = await measureRmsPerSecond(mediaPath);
  } catch (err) {
    // Segnale accessorio: se l'analisi audio fallisce la pipeline prosegue senza, non si blocca.
    logger.warn("Analisi energia vocale fallita, proseguo senza il segnale delle urla", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (levels.length < 10) return [];

  const baseline = median(levels.map((l) => l.db));
  const loudSeconds = levels.filter((l) => l.db - baseline >= SHOUT_THRESHOLD_DB);
  if (loudSeconds.length === 0) return [];

  const moments: LoudMoment[] = [];
  for (const second of loudSeconds) {
    const last = moments[moments.length - 1];
    if (last && second.time - last.end <= MERGE_GAP_SECONDS) {
      last.end = second.time + 1;
      last.aboveBaselineDb = Math.max(last.aboveBaselineDb, second.db - baseline);
    } else {
      moments.push({ start: second.time, end: second.time + 1, aboveBaselineDb: second.db - baseline });
    }
  }

  // Solo picchi in cui qualcuno sta DAVVERO parlando: senza questo filtro passavano anche gli
  // alert di iscrizione/donazione, gli stinger musicali e i rumori del gioco — forti ma non
  // "qualcuno che urla" (verificato su un video reale: un picco da +15dB era l'alert delle sub,
  // con nessuna voce sopra).
  const withSpeech = moments.filter((m) => segments.some((s) => s.start < m.end && s.end > m.start));

  const significant = withSpeech
    .filter((m) => m.end - m.start >= MIN_MOMENT_SECONDS)
    .sort((a, b) => b.aboveBaselineDb - a.aboveBaselineDb)
    .slice(0, MAX_MOMENTS)
    .sort((a, b) => a.start - b.start);

  logger.info("Momenti ad alta energia vocale rilevati", {
    count: significant.length,
    baselineDb: baseline.toFixed(1),
    strongest: significant.slice(0, 5).map((m) => `${m.start.toFixed(0)}s (+${m.aboveBaselineDb.toFixed(1)}dB)`),
  });

  return significant;
}

/**
 * Livello RMS dell'audio, un valore per ogni secondo. `asetnsamples` fissa la dimensione del
 * blocco a esattamente 1 secondo di campioni, `astats reset=1` azzera le statistiche a ogni
 * blocco e `ametadata=print` le stampa su stdout — così si ottiene una serie temporale in
 * streaming, senza tenere in memoria l'audio di un video lungo.
 */
async function measureRmsPerSecond(mediaPath: string): Promise<Array<{ time: number; db: number }>> {
  const { stdout } = await runFfmpeg([
    "-hide_banner",
    "-i",
    mediaPath,
    "-map",
    "0:a:0",
    "-af",
    "aresample=8000,asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f",
    "null",
    "-",
  ]);

  const levels: Array<{ time: number; db: number }> = [];
  let currentTime: number | null = null;

  for (const line of stdout.split("\n")) {
    const timeMatch = line.match(/pts_time:([0-9.]+)/);
    if (timeMatch?.[1]) {
      currentTime = Number(timeMatch[1]);
      continue;
    }
    const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[0-9.]+|-inf)/);
    if (rmsMatch?.[1] && currentTime !== null) {
      const db = rmsMatch[1] === "-inf" ? -100 : Number(rmsMatch[1]);
      if (Number.isFinite(db)) levels.push({ time: currentTime, db });
      currentTime = null;
    }
  }

  return levels;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
