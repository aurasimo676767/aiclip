import fsp from "node:fs/promises";
import path from "node:path";
import { probeVideo, runFfmpeg } from "../lib/ffmpeg.js";
import { toFfmpegFilterPath } from "./ffmpeg-filter-utils.js";
import { escapeAssText, formatAssTime } from "./captions.js";

const CREDITS_CARD_SECONDS = 3;
const CREDITS_CARD_FPS = 30;
const CREDITS_BACKGROUND_COLOR = "0x141414";

export interface RenderLongformClipParams {
  sourceVideoPath: string;
  start: number;
  end: number;
  /** Nome/handle dello streamer originale, mostrato nella card di apertura/chiusura. Null = testo generico. */
  streamerName: string | null;
  workDir: string;
  outputPath: string;
}

/**
 * Renderizza un segmento long-form: SOLO trim + card dei crediti allo streamer originale in
 * apertura/chiusura (nessun crop 9:16, zoom o sottotitoli sul contenuto principale — a
 * differenza degli Shorts, questo output resta orizzontale nella risoluzione nativa della
 * sorgente). Il testo della card usa il filtro "subtitles" (libass) invece di "drawtext": su
 * questa macchina drawtext richiede fontconfig configurato e fallisce ("Fontconfig error:
 * Cannot load default config file", crash del processo ffmpeg) — libass invece è già lo stesso
 * meccanismo, testato e funzionante, usato per i sottotitoli degli Shorts.
 */
export async function renderLongformClip(params: RenderLongformClipParams): Promise<{ durationSeconds: number }> {
  const { sourceVideoPath, start, end, streamerName, workDir, outputPath } = params;

  const sourceProbe = await probeVideo(sourceVideoPath);
  if (!sourceProbe.hasVideo || !sourceProbe.width || !sourceProbe.height) {
    throw new Error("Il file sorgente non contiene una traccia video valida");
  }
  if (!sourceProbe.hasAudio) {
    throw new Error("Il file sorgente non contiene una traccia audio (richiesta per il render long-form)");
  }

  const { width, height } = sourceProbe;
  const creditsText = streamerName ? `Live originale di ${streamerName}` : "Live originale";

  const assPath = path.join(workDir, "credits.ass");
  await fsp.writeFile(assPath, buildCreditsAss(creditsText, width, height), "utf-8");
  const assFilterPath = toFfmpegFilterPath(assPath);

  const filterComplex = [
    `[1:v]subtitles='${assFilterPath}',fps=${CREDITS_CARD_FPS},format=yuv420p[introv]`,
    `[3:v]subtitles='${assFilterPath}',fps=${CREDITS_CARD_FPS},format=yuv420p[outrov]`,
    `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,fps=${CREDITS_CARD_FPS},format=yuv420p[mainv]`,
    `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,aresample=44100[maina]`,
    `[2:a]aresample=44100[introa]`,
    `[4:a]aresample=44100[outroa]`,
    `[introv][introa][mainv][maina][outrov][outroa]concat=n=3:v=1:a=1[vraw][araw]`,
    // La card dei crediti è generata a parte (non deriva dalla sorgente) e potrebbe avere un
    // aspect ratio leggermente diverso in casi limite: format=yuv420p sopra normalizza il pixel
    // format, ma serve anche forzare le stesse dimensioni della sorgente per un concat pulito.
    `[vraw]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p[vout]`,
    // loudnorm va dentro il filtergraph complex: un -af "semplice" applicato a uno stream che
    // arriva già da un filtergraph complex viene rifiutato da ffmpeg ("Simple and complex
    // filtering cannot be used together for the same stream").
    `[araw]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`,
  ].join(";");

  await runFfmpeg(
    [
      "-y",
      "-i",
      sourceVideoPath,
      "-t",
      String(CREDITS_CARD_SECONDS),
      "-f",
      "lavfi",
      "-i",
      `color=c=${CREDITS_BACKGROUND_COLOR}:s=${width}x${height}:r=${CREDITS_CARD_FPS}`,
      "-t",
      String(CREDITS_CARD_SECONDS),
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      String(CREDITS_CARD_SECONDS),
      "-f",
      "lavfi",
      "-i",
      `color=c=${CREDITS_BACKGROUND_COLOR}:s=${width}x${height}:r=${CREDITS_CARD_FPS}`,
      "-t",
      String(CREDITS_CARD_SECONDS),
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-filter_complex",
      filterComplex,
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { timeoutMs: 20 * 60 * 1000 },
  );

  const outputProbe = await probeVideo(outputPath);
  return { durationSeconds: outputProbe.durationSeconds };
}

/** ASS minimale: una riga centrata, ferma per tutta la durata della card dei crediti. */
function buildCreditsAss(text: string, width: number, height: number): string {
  const fontSize = Math.round(height / 18);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,5,60,60,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const dialogue = `Dialogue: 0,${formatAssTime(0)},${formatAssTime(CREDITS_CARD_SECONDS)},Default,,0,0,0,,${escapeAssText(text)}`;
  return `${header}\n${dialogue}\n`;
}
