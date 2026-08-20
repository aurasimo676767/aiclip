import type { CropWindow } from "../face-tracking/face-tracker.js";
import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import { toFfmpegFilterPath } from "./ffmpeg-filter-utils.js";

export interface VideoFilterParams {
  faceCrop: CropWindow;
  zoomExpression: string;
  assSubtitlesPath: string;
  showProgressBar: boolean;
  clipDurationSeconds: number;
}

/**
 * Costruisce la catena di filtri video ffmpeg per una clip:
 * crop 9:16 (face tracking) -> crop dinamico per lo zoom/punch-in (EDL) -> scale finale ->
 * sottotitoli bruciati (ASS) -> progress bar opzionale.
 * Ritorna la stringa da passare a `-filter_complex`, con output finale su label `[vout]`.
 */
export function buildVideoFilterComplex(params: VideoFilterParams): string {
  const { faceCrop, zoomExpression, assSubtitlesPath, showProgressBar, clipDurationSeconds } = params;

  const steps: string[] = [];

  steps.push(
    `[0:v]crop=w=${faceCrop.width}:h=${faceCrop.height}:x=${faceCrop.x}:y=${faceCrop.y}[base]`,
  );

  steps.push(
    `[base]crop=w='trunc(iw/(${zoomExpression})/2)*2':h='trunc(ih/(${zoomExpression})/2)*2':x='(iw-out_w)/2':y='(ih-out_h)/2'[zoomed]`,
  );

  steps.push(`[zoomed]scale=${OUTPUT_RESOLUTION.width}:${OUTPUT_RESOLUTION.height}:flags=lanczos,setsar=1[scaled]`);

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
