import type { Layout } from "../face-tracking/face-tracker.js";
import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import { toFfmpegFilterPath } from "./ffmpeg-filter-utils.js";

export interface VideoFilterParams {
  layout: Layout;
  zoomExpression: string;
  assSubtitlesPath: string;
  showProgressBar: boolean;
  clipDurationSeconds: number;
}

/**
 * Costruisce la catena di filtri video ffmpeg per una clip:
 * crop 9:16 (face tracking, singolo o split_vertical per layout "reaction cam") -> crop
 * dinamico per lo zoom/punch-in (EDL) -> scale finale -> sottotitoli bruciati (ASS) ->
 * progress bar opzionale. Ritorna la stringa da passare a `-filter_complex`, con output
 * finale su label `[vout]`.
 */
export function buildVideoFilterComplex(params: VideoFilterParams): string {
  const { layout, zoomExpression, assSubtitlesPath, showProgressBar, clipDurationSeconds } = params;

  const steps: string[] =
    layout.type === "single" ? buildSingleCropSteps(layout.crop, zoomExpression) : buildSplitVerticalSteps(layout, zoomExpression);

  const subtitlesFilterPath = toFfmpegFilterPath(assSubtitlesPath);
  const lastLabel = "subbed";
  steps.push(`[scaled]subtitles='${subtitlesFilterPath}'[${lastLabel}]`);

  if (showProgressBar) {
    const safeDuration = Math.max(clipDurationSeconds, 0.1);
    steps.push(
      `[${lastLabel}]drawbox=x=0:y=ih-14:w='iw*min(t/${safeDuration.toFixed(3)}\\,1)':h=14:color=white@0.85:t=fill[vout]`,
    );
  } else {
    steps.push(`[${lastLabel}]null[vout]`);
  }

  return steps.join(";\n");
}

function buildSingleCropSteps(crop: { x: number; y: number; width: number; height: number }, zoomExpression: string): string[] {
  return [
    `[0:v]crop=w=${crop.width}:h=${crop.height}:x=${crop.x}:y=${crop.y}[base]`,
    `[base]crop=w='trunc(iw/(${zoomExpression})/2)*2':h='trunc(ih/(${zoomExpression})/2)*2':x='(iw-out_w)/2':y='(ih-out_h)/2'[zoomed]`,
    `[zoomed]scale=${OUTPUT_RESOLUTION.width}:${OUTPUT_RESOLUTION.height}:flags=lanczos,setsar=1[scaled]`,
  ];
}

function buildSplitVerticalSteps(
  layout: Extract<Layout, { type: "split_vertical" }>,
  zoomExpression: string,
): string[] {
  const topHeight = evenRound(OUTPUT_RESOLUTION.height * layout.topRatio);
  const bottomHeight = OUTPUT_RESOLUTION.height - topHeight;
  const { top, bottom } = layout;

  return [
    // Webcam: crop statico, nessuno zoom (l'area è già piccola/ravvicinata di suo).
    `[0:v]crop=w=${top.width}:h=${top.height}:x=${top.x}:y=${top.y},scale=${OUTPUT_RESOLUTION.width}:${topHeight}:flags=lanczos,setsar=1[top]`,
    // Contenuto principale: crop + zoom (EDL) come nel layout singolo, poi scala all'altezza restante.
    `[0:v]crop=w=${bottom.width}:h=${bottom.height}:x=${bottom.x}:y=${bottom.y}[bmain]`,
    `[bmain]crop=w='trunc(iw/(${zoomExpression})/2)*2':h='trunc(ih/(${zoomExpression})/2)*2':x='(iw-out_w)/2':y='(ih-out_h)/2'[bzoomed]`,
    `[bzoomed]scale=${OUTPUT_RESOLUTION.width}:${bottomHeight}:flags=lanczos,setsar=1[bottom]`,
    `[top][bottom]vstack=inputs=2[scaled]`,
  ];
}

function evenRound(value: number): number {
  return Math.round(value / 2) * 2;
}
