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
 * crop 9:16 che segue nel tempo lo speaker/webcam (face tracking, singolo, split_vertical o
 * "mixed" per layout reaction-cam con cambio scena a metà clip) -> crop dinamico per lo
 * zoom/punch-in (EDL) -> scale finale -> sottotitoli bruciati (ASS) -> progress bar opzionale.
 * Ritorna la stringa da passare a `-filter_complex`, con output finale su label `[vout]`.
 */
export function buildVideoFilterComplex(params: VideoFilterParams): string {
  const { layout, zoomExpression, assSubtitlesPath, showProgressBar, clipDurationSeconds } = params;

  let steps: string[];
  if (layout.type === "single") {
    steps = layout.backgroundFill ? buildSingleWithBackgroundSteps(layout.crops, zoomExpression) : buildSingleCropSteps(layout.crops, zoomExpression);
  } else if (layout.type === "split_vertical") {
    steps = buildSplitVerticalSteps(layout, zoomExpression);
  } else {
    steps = buildMixedSteps(layout, zoomExpression);
  }

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

function buildSingleCropSteps(crops: TimedCrop[], zoomExpression: string, prefix = ""): string[] {
  const xExpr = piecewiseExpr(crops, (c) => c.x);
  const yExpr = piecewiseExpr(crops, (c) => c.y);
  const wExpr = piecewiseExpr(crops, (c) => c.width);
  const hExpr = piecewiseExpr(crops, (c) => c.height);

  return [
    `[0:v]crop=w='${wExpr}':h='${hExpr}':x='${xExpr}':y='${yExpr}'[${prefix}base]`,
    `[${prefix}base]crop=w='trunc(iw/(${zoomExpression})/2)*2':h='trunc(ih/(${zoomExpression})/2)*2':x='(iw-out_w)/2':y='(ih-out_h)/2'[${prefix}zoomed]`,
    `[${prefix}zoomed]scale=${OUTPUT_RESOLUTION.width}:${OUTPUT_RESOLUTION.height}:flags=lanczos,setsar=1[${prefix}scaled]`,
  ];
}

// Quando il volto non riempie abbastanza il frame sorgente da restare centrato a piena canvas
// (Layout.backgroundFill, vedi face-tracker.ts), il riquadro del volto viene mostrato più
// piccolo — questa frazione della larghezza canvas — invece di stirato ai bordi, per lasciare
// spazio allo sfondo sfocato intorno.
const BACKGROUND_FILL_FOREGROUND_WIDTH_RATIO = 0.82;

/**
 * Come buildSingleCropSteps, ma per i casi in cui il volto non riempie bene un crop 9:16 a
 * piena canvas (Layout.backgroundFill): il crop del volto (già a rapporto 9:16, quindi la sua
 * dimensione IN PIXEL sorgente può variare ma la sua forma resta sempre verticale) viene
 * mostrato a una dimensione fissa e ridotta, centrato su uno sfondo ricavato dall'INTERO frame
 * sorgente scalato "a copertura" — spesso è proprio lo schermo/gioco reagito, normalmente
 * invisibile quando il volto occupa tutto lo schermo. Sfondo NITIDO, non sfocato: l'utente lo
 * vuole visibile chiaramente, non solo come ambiente sfumato sullo sfondo.
 */
function buildSingleWithBackgroundSteps(crops: TimedCrop[], zoomExpression: string, prefix = ""): string[] {
  const xExpr = piecewiseExpr(crops, (c) => c.x);
  const yExpr = piecewiseExpr(crops, (c) => c.y);
  const wExpr = piecewiseExpr(crops, (c) => c.width);
  const hExpr = piecewiseExpr(crops, (c) => c.height);

  const fgWidth = evenRound(OUTPUT_RESOLUTION.width * BACKGROUND_FILL_FOREGROUND_WIDTH_RATIO);
  const fgHeight = evenRound(fgWidth * (OUTPUT_RESOLUTION.height / OUTPUT_RESOLUTION.width));

  return [
    // Sfondo: l'intero frame sorgente scalato "a copertura" della canvas (un lato combacia,
    // l'altro sfora) poi tagliato al centro alle dimensioni esatte — sempre uguale per tutta
    // la clip (non segue il volto), lasciato nitido.
    `[0:v]scale=w=${OUTPUT_RESOLUTION.width}:h=${OUTPUT_RESOLUTION.height}:force_original_aspect_ratio=increase,crop=w=${OUTPUT_RESOLUTION.width}:h=${OUTPUT_RESOLUTION.height}[${prefix}bg]`,
    // Primo piano: stesso crop/zoom del volto di buildSingleCropSteps, ma scalato a una
    // dimensione fissa più piccola invece che stirato a piena canvas.
    `[0:v]crop=w='${wExpr}':h='${hExpr}':x='${xExpr}':y='${yExpr}'[${prefix}fg_base]`,
    `[${prefix}fg_base]crop=w='trunc(iw/(${zoomExpression})/2)*2':h='trunc(ih/(${zoomExpression})/2)*2':x='(iw-out_w)/2':y='(ih-out_h)/2'[${prefix}fg_zoomed]`,
    `[${prefix}fg_zoomed]scale=${fgWidth}:${fgHeight}:flags=lanczos,setsar=1[${prefix}fg]`,
    `[${prefix}bg][${prefix}fg]overlay=x='(W-w)/2':y='(H-h)/2',setsar=1[${prefix}scaled]`,
  ];
}

function buildSplitVerticalSteps(
  layout: Extract<Layout, { type: "split_vertical" }>,
  zoomExpression: string,
  prefix = "",
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
    `[0:v]crop=w='${topWExpr}':h='${topHExpr}':x='${topXExpr}':y='${topYExpr}',scale=${OUTPUT_RESOLUTION.width}:${topHeight}:flags=lanczos,setsar=1[${prefix}top]`,
    // Contenuto principale: crop statico centrato dell'intero frame sorgente.
    `[0:v]crop=w=${bottom.width}:h=${bottom.height}:x=${bottom.x}:y=${bottom.y}[${prefix}bmain]`,
  ];

  // Il crop "contenuto" sopra è dell'INTERO frame sorgente, quindi mostra di nuovo (piccola,
  // spesso tagliata) qualunque webcam venga già mostrata ravvicinata nel pannello "top" — le
  // sfochiamo qui, prima dello zoom EDL, così la sfocatura segue il crop invece di restare fissa.
  const localRegions = blurRegions
    .map((region) => intersectCropWithBottom(region, bottom))
    .filter((r): r is CropWindow => r !== null);

  let lastLabel = `${prefix}bmain`;
  localRegions.forEach((region, i) => {
    const patchLabel = `${prefix}bpatch${i}`;
    const nextLabel = `${prefix}bmain${i}`;
    steps.push(`[${lastLabel}]split=2[${lastLabel}_keep][${lastLabel}_src]`);
    steps.push(`[${lastLabel}_src]crop=w=${region.width}:h=${region.height}:x=${region.x}:y=${region.y},boxblur=24:3[${patchLabel}]`);
    steps.push(`[${lastLabel}_keep][${patchLabel}]overlay=${region.x}:${region.y}[${nextLabel}]`);
    lastLabel = nextLabel;
  });

  steps.push(
    `[${lastLabel}]crop=w='trunc(iw/(${zoomExpression})/2)*2':h='trunc(ih/(${zoomExpression})/2)*2':x='(iw-out_w)/2':y='(ih-out_h)/2'[${prefix}bzoomed]`,
    `[${prefix}bzoomed]scale=${OUTPUT_RESOLUTION.width}:${bottomHeight}:flags=lanczos,setsar=1[${prefix}bottom]`,
    `[${prefix}top][${prefix}bottom]vstack=inputs=2[${prefix}scaled]`,
  );

  return steps;
}

/**
 * Layout "mixed" (vedi face-tracker.ts): la scena sorgente cambia dentro la stessa clip, quindi
 * un unico layout fisso per tutta la durata romperebbe i tratti dove non vale più. Costruisce
 * ENTRAMBE le composizioni per l'intera durata (base "single" + split_vertical, con label
 * separate per non collidere) e sovrappone lo split SOLO nelle finestre `splitCrops` — fuori da
 * quelle finestre resta visibile la base. Costa il doppio in calcoli ffmpeg rispetto a un
 * layout puro, accettabile per la correttezza del risultato.
 */
function buildMixedSteps(layout: Extract<Layout, { type: "mixed" }>, zoomExpression: string): string[] {
  const baseSteps = layout.backgroundFill
    ? buildSingleWithBackgroundSteps(layout.singleCrops, zoomExpression, "base_")
    : buildSingleCropSteps(layout.singleCrops, zoomExpression, "base_");

  const splitLayout: Extract<Layout, { type: "split_vertical" }> = {
    type: "split_vertical",
    topCrops: layout.splitCrops,
    bottom: layout.bottom,
    topRatio: layout.topRatio,
    blurRegions: layout.blurRegions,
  };
  const splitSteps = buildSplitVerticalSteps(splitLayout, zoomExpression, "sv_");

  const enableExpr = layout.splitCrops.map((c) => `between(t,${c.startSeconds.toFixed(3)},${c.endSeconds.toFixed(3)})`).join("+");

  return [...baseSteps, ...splitSteps, `[base_scaled][sv_scaled]overlay=x=0:y=0:enable='${enableExpr}'[scaled]`];
}

// Sotto questa soglia (px) una regione da sfocare viene scartata invece di generare un crop
// ffmpeg minuscolo: un ritaglio troppo piccolo non serve a nulla, e arrotondare le coordinate
// PRIMA di derivarne la larghezza (vedi sotto) evita comunque lo zero, ma teniamo un margine.
const MIN_BLUR_REGION_PX = 4;

/**
 * Interseca `region` (coordinate sorgente) con il rettangolo `bottom`, tradotto in coordinate
 * locali al crop "contenuto". Null se non si sovrappongono affatto o l'overlap è troppo
 * sottile per avere senso. Arrotonda i BORDI (x0/y0/x1/y1) prima di derivarne larghezza/
 * altezza — arrotondarle indipendentemente (com'era prima) poteva produrre un crop con
 * larghezza o altezza 0 per un overlap sub-pixel, che ffmpeg rifiuta con un errore.
 */
function intersectCropWithBottom(region: CropWindow, bottom: CropWindow): CropWindow | null {
  const x0 = Math.round(Math.max(region.x, bottom.x));
  const y0 = Math.round(Math.max(region.y, bottom.y));
  const x1 = Math.round(Math.min(region.x + region.width, bottom.x + bottom.width));
  const y1 = Math.round(Math.min(region.y + region.height, bottom.y + bottom.height));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < MIN_BLUR_REGION_PX || height < MIN_BLUR_REGION_PX) return null;
  return { x: x0 - bottom.x, y: y0 - bottom.y, width, height };
}

/**
 * Costruisce un'espressione ffmpeg a tratti: `if(lt(t,fine1),val1,if(lt(t,fine2),val2,...,valN))`.
 * Usata per far "scattare" crop x/y/w/h da un segmento temporale al successivo (es. la webcam
 * che cambia posizione a metà clip), riusando lo stesso meccanismo di espressioni dipendenti da
 * `t` già usato per il pulse di zoom. I segmenti non devono essere contigui (vedi Layout "mixed":
 * `splitCrops` può avere buchi) — per i tempi fuori da qualunque intervallo elencato l'espressione
 * risolve comunque a un valore qualsiasi tra quelli forniti, il che va bene perché quei tratti non
 * sono comunque visibili (mai `enable`-ati nel layer sovrapposto).
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
