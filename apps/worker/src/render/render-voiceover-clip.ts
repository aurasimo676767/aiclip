import fsp from "node:fs/promises";
import path from "node:path";
import type { TranscriptSegment, CaptionStyleConfig } from "@clipforge/shared";
import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import { probeVideo, runFfmpeg } from "../lib/ffmpeg.js";
import { buildAssSubtitles } from "./captions.js";
import { toFfmpegFilterPath } from "./ffmpeg-filter-utils.js";

// Font già usato (e verificato funzionante) dal template MOTIVATIONAL: bold/condensato, molto
// leggibile una parola alla volta, adatto a contenuti "ad" tipo Whop. Nessun face-tracking qui
// (la clip è arbitraria, non una reaction-cam), quindi niente posizionamento "smart" — sempre in basso.
const VOICEOVER_CAPTION_STYLE: CaptionStyleConfig = {
  fontFamily: "Anton",
  fontSize: 84,
  position: "bottom",
  textColor: "#FFFFFF",
  highlightColor: "#FFD400",
  outlineColor: "#000000",
  wordByWord: true,
  oneWordAtATime: true,
  uppercase: true,
};

export interface RenderVoiceoverClipParams {
  videoPath: string;
  audioPath: string;
  transcriptSegments: TranscriptSegment[];
  workDir: string;
  outputPath: string;
}

/**
 * Renderizza una clip "voice over": nessuna AI di selezione/ranking, l'utente ha già scelto la
 * clip e l'audio. Crop 9:16 "a copertura" (nessun face-tracking, la clip è arbitraria), audio
 * ORIGINALE del video sostituito interamente da quello del voice over, sottotitoli
 * parola-per-parola trascritti dal voice over stesso.
 */
export async function renderVoiceoverClip(params: RenderVoiceoverClipParams): Promise<{ durationSeconds: number }> {
  const { videoPath, audioPath, transcriptSegments, workDir, outputPath } = params;
  await fsp.mkdir(workDir, { recursive: true });

  const videoProbe = await probeVideo(videoPath);
  if (!videoProbe.hasVideo) {
    throw new Error("Il file video non contiene una traccia video valida");
  }

  const assContent = buildAssSubtitles(transcriptSegments, VOICEOVER_CAPTION_STYLE, {});
  const assPath = path.join(workDir, "captions.ass");
  await fsp.writeFile(assPath, assContent, "utf-8");

  // "Cover": scala mantenendo l'aspect finché un lato combacia con la canvas 9:16, poi taglia
  // l'eccesso al centro sull'altro lato — stesso trattamento dello sfondo in
  // build-video-filter.ts, qui applicato al video stesso.
  const filterComplex = [
    `[0:v]scale=w=${OUTPUT_RESOLUTION.width}:h=${OUTPUT_RESOLUTION.height}:force_original_aspect_ratio=increase,` +
      `crop=w=${OUTPUT_RESOLUTION.width}:h=${OUTPUT_RESOLUTION.height},setsar=1[scaled]`,
    `[scaled]subtitles='${toFfmpegFilterPath(assPath)}'[vout]`,
  ].join(";\n");

  const args = [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[vout]",
    "-map",
    "1:a:0",
    "-af",
    "loudnorm=I=-14:TP=-1.5:LRA=11",
    // Il video e il voice over quasi mai combaciano esattamente in durata: si taglia al più
    // breve dei due invece di lasciare un tratto muto o video nero in coda.
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "15",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  await runFfmpeg(args, { timeoutMs: 10 * 60 * 1000 });

  const outputProbe = await probeVideo(outputPath);
  return { durationSeconds: outputProbe.durationSeconds };
}
