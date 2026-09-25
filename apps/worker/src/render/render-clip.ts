import fsp from "node:fs/promises";
import path from "node:path";
import type { RankedClip, TranscriptSegment, TemplateConfig } from "@clipforge/shared";
import { probeVideo, runFfmpeg } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";
import type { FaceTracker, Layout, TimedCrop } from "../face-tracking/face-tracker.js";
import { buildAssSubtitles, screamWindows } from "./captions.js";
import { buildVideoFilterComplex, type ContentView } from "./build-video-filter.js";
import { detectSilences, detectQuietSpeechGaps, mergeIntervals, computeKeepSegments, buildTimeRemap, type TimeSegment } from "./silence.js";
import { trimToKeepSegments } from "./trim-concat.js";
import { annotateWordLoudness } from "./word-loudness.js";

export interface RenderClipParams {
  sourceVideoPath: string;
  clip: RankedClip;
  template: TemplateConfig;
  transcriptSegments: TranscriptSegment[];
  faceTracker: FaceTracker;
  workDir: string;
  outputPath: string;
  /**
   * Regia del pannello del gioco (vedi providers/ai/content-focus.ts): quando mostrarlo intero o
   * zoomare. Assente = gioco riempito per tutta la clip, senza chiamate a pagamento.
   */
  planContentViews?: (input: { videoPath: string; layout: Layout; durationSeconds: number; segments: TranscriptSegment[] }) => Promise<ContentView[]>;
}

/**
 * Ingrandimento del primo piano sugli urli per unità di zoomIntensity del template: STREAMER (1.5)
 * zooma del 18%, PODCAST_DYNAMIC (1.2) del 14%, PODCAST_CLEAN (0.4) del 5%.
 */
const PUNCH_ZOOM_PER_INTENSITY = 0.12;

/** Renderizza una singola clip end-to-end: taglio, rimozione silenzi, crop 9:16, zoom, captions, loudness. */
export async function renderClip(params: RenderClipParams): Promise<{ durationSeconds: number }> {
  const { sourceVideoPath, clip, template, transcriptSegments, faceTracker, workDir, outputPath, planContentViews } = params;
  await fsp.mkdir(workDir, { recursive: true });

  const sourceProbe = await probeVideo(sourceVideoPath);
  if (!sourceProbe.hasVideo || !sourceProbe.width || !sourceProbe.height) {
    throw new Error("Il file sorgente non contiene una traccia video valida");
  }

  const clipDuration = clip.end - clip.start;
  const rawClipPath = path.join(workDir, "clip_raw.mp4");
  await extractRawClip(sourceVideoPath, clip.start, clipDuration, rawClipPath, sourceProbe.hasAudio);

  let workingClipPath = rawClipPath;
  let timeRemap: (t: number) => number = (t) => t;
  let finalDuration = clipDuration;

  if (template.silenceRemovalThresholdSeconds !== null && sourceProbe.hasAudio) {
    const audioSilences = await detectSilences(rawClipPath, { minDurationSeconds: template.silenceRemovalThresholdSeconds });
    // Più i buchi nel PARLATO (vedi detectQuietSpeechGaps): negli stream il gioco copre il silenzio.
    const clipWords = transcriptSegments
      .flatMap((s) => s.words)
      .filter((w) => w.start >= clip.start && w.start < clip.end)
      .map((w) => ({ ...w, start: w.start - clip.start, end: Math.min(clip.end, w.end) - clip.start }));
    const speechGaps = await detectQuietSpeechGaps(rawClipPath, clipWords, template.silenceRemovalThresholdSeconds);
    const silences = mergeIntervals([...audioSilences, ...speechGaps]);
    const keepSegments = computeKeepSegments(clipDuration, silences, {
      minDurationToCutSeconds: template.silenceRemovalThresholdSeconds,
    });

    if (keepSegments.length > 1 || (keepSegments.length === 1 && segmentIsShorterThanClip(keepSegments[0]!, clipDuration))) {
      const trimmedPath = path.join(workDir, "clip_trimmed.mp4");
      await trimToKeepSegments(rawClipPath, trimmedPath, keepSegments);
      workingClipPath = trimmedPath;
      timeRemap = buildTimeRemap(keepSegments);
      finalDuration = keepSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
      logger.info("Silenzi rimossi dalla clip", {
        clipDuration,
        finalDuration,
        silenziAudio: audioSilences.length,
        buchiNelParlato: speechGaps.map((g) => `${g.start.toFixed(1)}-${g.end.toFixed(1)}`),
      });
    }
  }

  // Volume di ogni parola rispetto al parlato attorno alla clip: i sottotitoli colorano le urla.
  const withLoudness = sourceProbe.hasAudio ? await annotateWordLoudness(sourceVideoPath, transcriptSegments, clip.start, clip.end) : transcriptSegments;
  const clipRelativeSegments = sliceAndRemapSegments(withLoudness, clip.start, clip.end, timeRemap);
  const highlightWords = new Set(
    clip.edl.events
      .filter((e): e is Extract<typeof e, { action: "highlight_word" }> => e.action === "highlight_word")
      .map((e) => e.word.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase()),
  );

  const rawLayout = await faceTracker.computeLayout({
    sourceVideoPath,
    sourceWidth: sourceProbe.width,
    sourceHeight: sourceProbe.height,
    startSeconds: clip.start,
    endSeconds: clip.end,
  });
  const layout = remapLayout(rawLayout, timeRemap, finalDuration);

  // Il layout serve QUI (position "smart" segue il confine webcam/contenuto quando presente),
  // per questo viene calcolato prima delle caption invece che dopo come in origine.
  const assContent = buildAssSubtitles(clipRelativeSegments, template.captionStyle, { highlightWords, layout });
  const assPath = path.join(workDir, "captions.ass");
  await fsp.writeFile(assPath, assContent, "utf-8");

  const contentViews = planContentViews
    ? await planContentViews({ videoPath: workingClipPath, layout, durationSeconds: finalDuration, segments: clipRelativeSegments }).catch((error) => {
        logger.warn("Regia del gioco fallita, gioco riempito per tutta la clip", { error: error instanceof Error ? error.message : String(error) });
        return [];
      })
    : [];

  const filterComplex = buildVideoFilterComplex({
    contentViews,
    layout,
    assSubtitlesPath: assPath,
    showProgressBar: template.showProgressBar,
    clipDurationSeconds: finalDuration,
    // Primo piano netto sugli urli, con l'intensità di zoom del template (0 = mai).
    punchIns: template.zoomIntensity > 0 ? screamWindows(clipRelativeSegments) : [],
    punchZoom: 1 + PUNCH_ZOOM_PER_INTENSITY * template.zoomIntensity,
  });

  const args = ["-y", "-i", workingClipPath, "-filter_complex", filterComplex, "-map", "[vout]"];

  if (sourceProbe.hasAudio) {
    args.push("-map", "0:a:0", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }

  // crf 15 + preset slow: le clip sono corte (30-60s), il file finale resta comunque piccolo
  // e il tempo di render extra (preset più lento = miglior efficienza di compressione a
  // parità di qualità) è accettabile per un output pensato per essere pubblicato, non solo
  // guardato una volta.
  args.push("-c:v", "libx264", "-preset", "slow", "-crf", "15", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath);

  await runFfmpeg(args, { timeoutMs: 10 * 60 * 1000 });

  const outputProbe = await probeVideo(outputPath);
  return { durationSeconds: outputProbe.durationSeconds };
}

async function extractRawClip(
  sourceVideoPath: string,
  startSeconds: number,
  durationSeconds: number,
  outputPath: string,
  hasAudio: boolean,
): Promise<void> {
  const args = ["-y", "-ss", String(startSeconds), "-i", sourceVideoPath, "-t", String(durationSeconds)];
  // Qualità alta anche qui (non solo sul render finale): questo file intermedio viene poi
  // croppato e spesso ingrandito (es. sulla webcam), quindi ogni perdita di dettaglio qui
  // si amplifica con l'upscale successivo.
  args.push("-c:v", "libx264", "-preset", "fast", "-crf", "14");
  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }
  args.push(outputPath);
  await runFfmpeg(args);
}

function segmentIsShorterThanClip(segment: TimeSegment, clipDuration: number): boolean {
  return segment.end - segment.start < clipDuration - 0.05;
}

/**
 * Applica il remap dei silenzi (vedi silence.ts) ai confini temporali dei TimedCrop di un
 * Layout — necessario perché il crop viene calcolato sulla timeline "originale" della clip,
 * ma il filtergraph ffmpeg gira sul file GIÀ tagliato (senza silenzi), con `t` che riparte da 0.
 */
function remapLayout(layout: Layout, timeRemap: (t: number) => number, finalDuration: number): Layout {
  if (layout.type === "scenes") {
    const remapped = layout.scenes
      .map((s) => ({ ...s, startSeconds: timeRemap(s.startSeconds), endSeconds: timeRemap(s.endSeconds) }))
      .filter((s) => s.endSeconds > s.startSeconds + 0.01);
    if (remapped.length === 0) {
      const last = layout.scenes[layout.scenes.length - 1]!;
      return { ...layout, scenes: [{ ...last, startSeconds: 0, endSeconds: finalDuration }] };
    }
    remapped[remapped.length - 1]!.endSeconds = finalDuration;
    return { ...layout, scenes: remapped };
  }
  return { ...layout, topCrops: remapTimedCrops(layout.topCrops, timeRemap, finalDuration) };
}

function remapTimedCrops(crops: TimedCrop[], timeRemap: (t: number) => number, finalDuration: number): TimedCrop[] {
  const remapped = crops
    .map((c) => ({ startSeconds: timeRemap(c.startSeconds), endSeconds: timeRemap(c.endSeconds), crop: c.crop }))
    .filter((c) => c.endSeconds > c.startSeconds + 0.01);

  if (remapped.length === 0) {
    const last = crops[crops.length - 1];
    return [{ startSeconds: 0, endSeconds: finalDuration, crop: (last ?? crops[0]!).crop }];
  }

  remapped[remapped.length - 1]!.endSeconds = finalDuration;
  return remapped;
}

/** Estrae i segmenti transcript dentro [clipStart, clipEnd], li rende clip-relativi e applica il remap dei silenzi. */
function sliceAndRemapSegments(
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
  timeRemap: (t: number) => number,
): TranscriptSegment[] {
  return segments
    .filter((seg) => seg.end > clipStart && seg.start < clipEnd)
    .map((seg) => ({
      ...seg,
      start: timeRemap(Math.max(0, seg.start - clipStart)),
      end: timeRemap(Math.min(clipEnd, seg.end) - clipStart),
      words: seg.words
        .filter((w) => w.start >= clipStart && w.start <= clipEnd)
        .map((w) => ({
          ...w,
          start: timeRemap(w.start - clipStart),
          end: timeRemap(Math.max(w.start, Math.min(clipEnd, w.end)) - clipStart),
        })),
    }))
    .filter((seg) => seg.words.length > 0 || !seg.text);
}
