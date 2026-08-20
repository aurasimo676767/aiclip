import fsp from "node:fs/promises";
import path from "node:path";
import type { RankedClip, TranscriptSegment, TemplateConfig } from "@clipforge/shared";
import { probeVideo, runFfmpeg } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";
import type { FaceTracker, Layout, TimedCrop } from "../face-tracking/face-tracker.js";
import { buildZoomExpression } from "./edl-executor.js";
import { buildAssSubtitles } from "./captions.js";
import { buildVideoFilterComplex } from "./build-video-filter.js";
import { detectSilences, computeKeepSegments, buildTimeRemap, type TimeSegment } from "./silence.js";
import { trimToKeepSegments } from "./trim-concat.js";

export interface RenderClipParams {
  sourceVideoPath: string;
  clip: RankedClip;
  template: TemplateConfig;
  transcriptSegments: TranscriptSegment[];
  faceTracker: FaceTracker;
  workDir: string;
  outputPath: string;
}

/** Renderizza una singola clip end-to-end: taglio, rimozione silenzi, crop 9:16, zoom, captions, loudness. */
export async function renderClip(params: RenderClipParams): Promise<{ durationSeconds: number }> {
  const { sourceVideoPath, clip, template, transcriptSegments, faceTracker, workDir, outputPath } = params;
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
    const silences = await detectSilences(rawClipPath, { minDurationSeconds: template.silenceRemovalThresholdSeconds });
    const keepSegments = computeKeepSegments(clipDuration, silences, {
      minDurationToCutSeconds: template.silenceRemovalThresholdSeconds,
    });

    if (keepSegments.length > 1 || (keepSegments.length === 1 && segmentIsShorterThanClip(keepSegments[0]!, clipDuration))) {
      const trimmedPath = path.join(workDir, "clip_trimmed.mp4");
      await trimToKeepSegments(rawClipPath, trimmedPath, keepSegments);
      workingClipPath = trimmedPath;
      timeRemap = buildTimeRemap(keepSegments);
      finalDuration = keepSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
      logger.info("Silenzi rimossi dalla clip", { clipDuration, finalDuration, removedSegments: silences.length });
    }
  }

  const clipRelativeSegments = sliceAndRemapSegments(transcriptSegments, clip.start, clip.end, timeRemap);
  const highlightWords = new Set(
    clip.edl.events
      .filter((e): e is Extract<typeof e, { action: "highlight_word" }> => e.action === "highlight_word")
      .map((e) => e.word.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase()),
  );

  const assContent = buildAssSubtitles(clipRelativeSegments, template.captionStyle, { highlightWords });
  const assPath = path.join(workDir, "captions.ass");
  await fsp.writeFile(assPath, assContent, "utf-8");

  const remappedEvents = clip.edl.events
    .map((event) => ({ ...event, time: timeRemap(event.time - clip.start) }))
    .filter((event) => event.time >= 0 && event.time <= finalDuration);

  const zoomExpression = buildZoomExpression(remappedEvents, template.zoomIntensity);

  const rawLayout = await faceTracker.computeLayout({
    sourceVideoPath,
    sourceWidth: sourceProbe.width,
    sourceHeight: sourceProbe.height,
    startSeconds: clip.start,
    endSeconds: clip.end,
  });
  const layout = remapLayout(rawLayout, timeRemap, finalDuration);

  const filterComplex = buildVideoFilterComplex({
    layout,
    zoomExpression,
    assSubtitlesPath: assPath,
    showProgressBar: template.showProgressBar,
    clipDurationSeconds: finalDuration,
  });

  const args = ["-y", "-i", workingClipPath, "-filter_complex", filterComplex, "-map", "[vout]"];

  if (sourceProbe.hasAudio) {
    args.push("-map", "0:a:0", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }

  // crf 17 ~ qualità visivamente vicina al lossless: le clip sono corte (30-60s), il file
  // finale resta comunque piccolo, non c'è motivo di comprimere aggressivamente.
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath);

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
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "16");
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
  if (layout.type === "single") {
    return { type: "single", crops: remapTimedCrops(layout.crops, timeRemap, finalDuration) };
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
