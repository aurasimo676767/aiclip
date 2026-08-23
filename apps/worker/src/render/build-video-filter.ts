import type { CropWindow, Layout, TimedCrop } from "../face-tracking/face-tracker.js";
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
 * crop 9:16 che segue nel tempo lo speaker/webcam (face tracking, singolo o split_vertical
 * per layout "reaction cam") -> crop dinamico per lo zoom/punch-in (EDL) -> scale finale ->
 * sottotitoli bruciati (ASS) -> progress bar opzionale.
 * Ritorna la stringa da passare a `-filter_complex`, con output finale su label `[vout]`.
 */
export function buildVideoFilterComplex(params: VideoFilterParams): string {
  const { layout, zoomExpression, assSubtitlesPath, showProgressBar, clipDurationSeconds } = params;

  const steps: string[] =
    layout.type === "single" ? buildSingleCropSteps(layout.crops, zoomExpression) : buildSplitVerticalSteps(layout, zoomExpression);

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

function buildSingleCropSteps(crops: TimedCrop[], zoomExpression: string): string[] {
  const xExpr = piecewiseExpr(crops, (c) => c.x);
  const yExpr = piecewiseExpr(crops, (c) => c.y);
  const wExpr = piecewiseExpr(crops, (c) => c.width);
  const hExpr = piecewiseExpr(crops, (c) => c.height);

  return [
    `[0:v]crop=w='${wExpr}':h='${hExpr}':x='${xExpr}':y='${yExpr}'[base]`,
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
  const { topCrops, bottom, blurRegions } = layout;

  const topXExpr = piecewiseExpr(topCrops, (c) => c.x);
  const topYExpr = piecewiseExpr(topCrops, (c) => c.y);
  const topWExpr = piecewiseExpr(topCrops, (c) => c.width);
  const topHExpr = piecewiseExpr(topCrops, (c) => c.height);

  const steps = [
    // Webcam: crop che segue nel tempo il segmento attivo, nessuno zoom EDL (l'area è già ravvicinata di suo).
    `[0:v]crop=w='${topWExpr}':h='${topHExpr}':x='${topXExpr}':y='${topYExpr}',scale=${OUTPUT_RESOLUTION.width}:${topHeight}:flags=lanczos,setsar=1[top]`,
    // Contenuto principale: crop statico centrato dell'intero frame sorgente.
    `[0:v]crop=w=${bottom.width}:h=${bottom.height}:x=${bottom.x}:y=${bottom.y}[bmain]`,
  ];

  // Il crop "contenuto" sopra è dell'INTERO frame sorgente, quindi mostra di nuovo (piccola,
  // spesso tagliata) qualunque webcam venga già mostrata ravvicinata nel pannello "top" — le
  // sfochiamo qui, prima dello zoom EDL, così la sfocatura segue il crop invece di restare fissa.
  const localRegions = blurRegions
    .map((region) => intersectCropWithBottom(region, bottom))
    .filter((r): r is CropWindow => r !== null);

  let lastLabel = "bmain";
  localRegions.forEach((region, i) => {
    const patchLabel = `bpatch${i}`;
    const nextLabel = `bmain${i}`;
    steps.push(`[${lastLabel}]split=2[${lastLabel}_keep][${lastLabel}_src]`);
    steps.push(`[${lastLabel}_src]crop=w=${region.width}:h=${region.height}:x=${region.x}:y=${region.y},boxblur=24:3[${patchLabel}]`);
    steps.push(`[${lastLabel}_keep][${patchLabel}]overlay=${region.x}:${region.y}[${nextLabel}]`);
    lastLabel = nextLabel;
  });

  steps.push(
    `[${lastLabel}]crop=w='trunc(iw/(${zoomExpression})/2)*2':h='trunc(ih/(${zoomExpression})/2)*2':x='(iw-out_w)/2':y='(ih-out_h)/2'[bzoomed]`,
    `[bzoomed]scale=${OUTPUT_RESOLUTION.width}:${bottomHeight}:flags=lanczos,setsar=1[bottom]`,
    `[top][bottom]vstack=inputs=2[scaled]`,
  );

  return steps;
}

/** Interseca `region` (coordinate sorgente) con il rettangolo `bottom`, tradotto in coordinate locali al crop "contenuto". Null se non si sovrappongono affatto. */
function intersectCropWithBottom(region: CropWindow, bottom: CropWindow): CropWindow | null {
  const x0 = Math.max(region.x, bottom.x);
  const y0 = Math.max(region.y, bottom.y);
  const x1 = Math.min(region.x + region.width, bottom.x + bottom.width);
  const y1 = Math.min(region.y + region.height, bottom.y + bottom.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: Math.round(x0 - bottom.x), y: Math.round(y0 - bottom.y), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}

/**
 * Costruisce un'espressione ffmpeg a tratti: `if(lt(t,fine1),val1,if(lt(t,fine2),val2,...,valN))`.
 * Usata per far "scattare" crop x/y/w/h da un segmento temporale al successivo (es. la webcam
 * che cambia posizione a metà clip), riusando lo stesso meccanismo di espressioni dipendenti da
 * `t` già usato per il pulse di zoom.
 */
function piecewiseExpr(crops: TimedCrop[], pick: (crop: TimedCrop["crop"]) => number): string {
  if (crops.length === 0) {
    throw new Error("piecewiseExpr: nessun segmento di crop fornito");
  }
  if (crops.length === 1) {
    return String(pick(crops[0]!.crop));
  }

  let expr = String(pick(crops[crops.length - 1]!.crop));
  for (let i = crops.length - 2; i >= 0; i--) {
    const segment = crops[i]!;
    expr = `if(lt(t,${segment.endSeconds.toFixed(3)}),${pick(segment.crop)},${expr})`;
  }
  return expr;
}

function evenRound(value: number): number {
  return Math.round(value / 2) * 2;
}
