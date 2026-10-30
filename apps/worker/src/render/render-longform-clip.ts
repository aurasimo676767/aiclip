import fsp from "node:fs/promises";
import path from "node:path";
import { probeVideo, runFfmpeg } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";
import { planLongformEdit, renderEditedLongform, type HighlightsInput } from "./longform-auto-edit.js";
import { findMutedRanges, piecesWithoutMuted } from "./muted-ranges.js";

// Target audio comune al segmento estratto — l'audio viene comunque ri-codificato per il
// loudnorm, quindi tanto vale fissare qui dei parametri stabili.
const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 2;

export interface RenderLongformClipParams {
  sourceVideoPath: string;
  start: number;
  end: number;
  workDir: string;
  /** Montaggio automatico (clips.longform_edit): tempi morti tagliati e stacchi sulle urla. Serve il tracker per trovare le webcam. */
  autoEdit?: { highlights?: HighlightsInput };
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
 *
 * I tratti mutati da Twitch si tolgono (vedi muted-ranges.ts); il montato li toglie già da solo,
 * come ogni silenzio.
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

  if (params.autoEdit) {
    const plan = await planLongformEdit({
      sourceVideoPath,
      sourceWidth: sourceProbe.width,
      sourceHeight: sourceProbe.height,
      start,
      end,
      highlights: params.autoEdit.highlights,
    });
    await renderEditedLongform({ sourceVideoPath, start, end, plan, workDir: params.workDir, outputPath });
    const editedProbe = await probeVideo(outputPath);
    logger.info("Video long-form montato", { durata: Math.round(end - start), montato: Math.round(editedProbe.durationSeconds), stacchi: plan.punches.length, intro: plan.intro.length });
    return { durationSeconds: editedProbe.durationSeconds };
  }

  const trim = (from: number, to: number, out: string) =>
    runFfmpeg(
      [
        "-y",
        "-ss",
        String(from),
        "-to",
        String(to),
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
        out,
      ],
      // Proporzionale alla durata: un tetto fisso di 10 minuti ha ucciso il render di un video da 21
      // minuti (2026-09-25) mentre il disco era sotto carico. Copia video + audio con loudnorm stanno
      // ben sotto il tempo reale, quindi "durata del video, minimo 10 minuti" lascia molto margine.
      { timeoutMs: Math.max(10 * 60, to - from) * 1000 },
    );

  const muted = await findMutedRanges(sourceVideoPath, start, end);
  const pieces = piecesWithoutMuted(start, end, muted);
  if (muted.length > 0 && pieces.length > 0) {
    logger.warn("Tratti senza audio (muto di Twitch) tolti dal video", { muted, pieces });
    const parts = pieces.map((_, i) => path.resolve(params.workDir, `piece-${i}.mp4`));
    for (let i = 0; i < pieces.length; i++) await trim(pieces[i]!.start, pieces[i]!.end, parts[i]!);
    const listPath = path.join(params.workDir, "pieces.ffconcat");
    const list = parts.map((part) => `file '${part.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`).join("");
    await fsp.writeFile(listPath, `ffconcat version 1.0\n${list}`);
    await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outputPath], { timeoutMs: 10 * 60 * 1000 });
  } else {
    if (muted.length > 0) logger.warn("Video quasi tutto senza audio: resta intero", { muted });
    await trim(start, end, outputPath);
  }

  const outputProbe = await probeVideo(outputPath);
  return { durationSeconds: outputProbe.durationSeconds };
}
