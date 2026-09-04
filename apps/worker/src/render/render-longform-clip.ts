import { probeVideo, runFfmpeg } from "../lib/ffmpeg.js";

// Target audio comune al segmento estratto — l'audio viene comunque ri-codificato per il
// loudnorm, quindi tanto vale fissare qui dei parametri stabili.
const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 2;

export interface RenderLongformClipParams {
  sourceVideoPath: string;
  start: number;
  end: number;
  workDir: string;
  outputPath: string;
}

/**
 * Renderizza un segmento long-form: SOLO trim (nessun crop 9:16, zoom, sottotitoli o card di
 * apertura/chiusura sul contenuto principale — rimosse su richiesta). Il video viene estratto con
 * COPIA DIRETTA (nessun decode/encode, quindi zero perdita di qualità rispetto alla sorgente) —
 * solo l'audio viene ri-codificato, per applicare comunque il loudnorm.
 *
 * Nota sul taglio: con la ricerca a livello di demuxer (-ss prima di -i, necessaria per essere
 * rapida) il punto di inizio effettivo si allinea al fotogramma-chiave più vicino, non al secondo
 * esatto scelto dall'AI — lo scarto tipico è di 1-4 secondi, impercettibile per un blocco di
 * attività intero.
 */
export async function renderLongformClip(params: RenderLongformClipParams): Promise<{ durationSeconds: number }> {
  const { sourceVideoPath, start, end, outputPath } = params;

  const sourceProbe = await probeVideo(sourceVideoPath);
  if (!sourceProbe.hasVideo || !sourceProbe.width || !sourceProbe.height) {
    throw new Error("Il file sorgente non contiene una traccia video valida");
  }
  if (!sourceProbe.hasAudio) {
    throw new Error("Il file sorgente non contiene una traccia audio (richiesta per il render long-form)");
  }

  await runFfmpeg(
    [
      "-y",
      "-ss",
      String(start),
      "-to",
      String(end),
      "-i",
      sourceVideoPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-ar",
      String(AUDIO_SAMPLE_RATE),
      "-ac",
      String(AUDIO_CHANNELS),
      "-b:a",
      "192k",
      "-af",
      "loudnorm=I=-14:TP=-1.5:LRA=11",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { timeoutMs: 10 * 60 * 1000 },
  );

  const outputProbe = await probeVideo(outputPath);
  return { durationSeconds: outputProbe.durationSeconds };
}
