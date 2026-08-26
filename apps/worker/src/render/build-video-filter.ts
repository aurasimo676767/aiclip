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
    steps = layout.backgroundFill
      ? buildSingleWithBackgroundSteps(layout.crops, zoomExpression, clipDurationSeconds)
      : buildSingleCropSteps(layout.crops, zoomExpression, clipDurationSeconds);
  } else if (layout.type === "split_vertical") {
    steps = buildSplitVerticalSteps(layout, zoomExpression, clipDurationSeconds);
  } else {
    steps = buildMixedSteps(layout, zoomExpression, clipDurationSeconds);
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

function buildSingleCropSteps(crops: TimedCrop[], zoomExpression: string, totalDuration: number, prefix = ""): string[] {
  const cropSteps = buildCroppedSteps(crops, totalDuration, OUTPUT_RESOLUTION.width, OUTPUT_RESOLUTION.height, `${prefix}base`);

  return [
    ...cropSteps,
    `[${prefix}base]crop=w='trunc(iw/(${zoomExpression})/2)*2':h='trunc(ih/(${zoomExpression})/2)*2':x='(iw-out_w)/2':y='(ih-out_h)/2'[${prefix}zoomed]`,
    `[${prefix}zoomed]scale=${OUTPUT_RESOLUTION.width}:${OUTPUT_RESOLUTION.height}:flags=lanczos,setsar=1[${prefix}scaled]`,
  ];
}

/**
 * Come buildSingleCropSteps, ma per i casi in cui il volto non riempie bene un crop a piena
 * canvas (Layout.backgroundFill): i crop in ingresso sono ora quadrati (BACKGROUND_FILL_ASPECT
 * in reaction-cam-face-tracker.ts, l'inquadratura naturale di una webcam) invece che forzati a
 * 9:16 — mostrati a PIENA LARGHEZZA (niente bordi laterali, solo sopra/sotto, come richiesto
 * esplicitamente) su uno sfondo ricavato dall'INTERO frame sorgente scalato "a copertura" —
 * spesso è proprio lo schermo/gioco reagito, normalmente invisibile quando il volto occupa
 * tutto lo schermo. Sfondo NITIDO, non sfocato: l'utente lo vuole visibile chiaramente.
 */
function buildSingleWithBackgroundSteps(crops: TimedCrop[], zoomExpression: string, totalDuration: number, prefix = ""): string[] {
  // Piena larghezza: i crop in ingresso sono quadrati, quindi altezza=larghezza mantiene
  // l'aspect e lascia il resto della canvas (sopra/sotto) allo sfondo — mai bordi laterali.
  const fgWidth = OUTPUT_RESOLUTION.width;
  const fgHeight = OUTPUT_RESOLUTION.width;

  const cropSteps = buildCroppedSteps(crops, totalDuration, fgWidth, fgHeight, `${prefix}fg_base`);

  return [
    // Sfondo: l'intero frame sorgente scalato "a copertura" della canvas (un lato combacia,
    // l'altro sfora) poi tagliato al centro alle dimensioni esatte — sempre uguale per tutta
    // la clip (non segue il volto), lasciato nitido.
    `[0:v]scale=w=${OUTPUT_RESOLUTION.width}:h=${OUTPUT_RESOLUTION.height}:force_original_aspect_ratio=increase,crop=w=${OUTPUT_RESOLUTION.width}:h=${OUTPUT_RESOLUTION.height}[${prefix}bg]`,
    // Primo piano: stesso crop/zoom del volto di buildSingleCropSteps, ma scalato a piena
    // larghezza invece che sull'intera canvas verticale.
    ...cropSteps,
    `[${prefix}fg_base]crop=w='trunc(iw/(${zoomExpression})/2)*2':h='trunc(ih/(${zoomExpression})/2)*2':x='(iw-out_w)/2':y='(ih-out_h)/2'[${prefix}fg_zoomed]`,
    `[${prefix}fg_zoomed]scale=${fgWidth}:${fgHeight}:flags=lanczos,setsar=1[${prefix}fg]`,
    `[${prefix}bg][${prefix}fg]overlay=x='(W-w)/2':y='(H-h)/2',setsar=1[${prefix}scaled]`,
  ];
}

function buildSplitVerticalSteps(
  layout: Extract<Layout, { type: "split_vertical" }>,
  zoomExpression: string,
  totalDuration: number,
  prefix = "",
): string[] {
  const topHeight = evenRound(OUTPUT_RESOLUTION.height * layout.topRatio);
  const bottomHeight = OUTPUT_RESOLUTION.height - topHeight;
  const { topCrops, bottom, blurRegions } = layout;

  const topSteps = buildCroppedSteps(topCrops, totalDuration, OUTPUT_RESOLUTION.width, topHeight, `${prefix}top`);

  const steps = [
    // Webcam: crop che segue nel tempo il segmento attivo, nessuno zoom EDL (l'area è già ravvicinata di suo).
    ...topSteps,
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
function buildMixedSteps(layout: Extract<Layout, { type: "mixed" }>, zoomExpression: string, totalDuration: number): string[] {
  const baseSteps = layout.backgroundFill
    ? buildSingleWithBackgroundSteps(layout.singleCrops, zoomExpression, totalDuration, "base_")
    : buildSingleCropSteps(layout.singleCrops, zoomExpression, totalDuration, "base_");

  const splitLayout: Extract<Layout, { type: "split_vertical" }> = {
    type: "split_vertical",
    topCrops: layout.splitCrops,
    bottom: layout.bottom,
    topRatio: layout.topRatio,
    blurRegions: layout.blurRegions,
  };
  const splitSteps = buildSplitVerticalSteps(splitLayout, zoomExpression, totalDuration, "sv_");

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

// Un frame di margine (secondi) usato per considerare "coperta" una clip il cui ultimo/primo
// crop non arriva esattamente a 0/totalDuration per il solo arrotondamento in virgola mobile.
const GAP_EPSILON_SECONDS = 0.01;

/**
 * Costruisce gli step ffmpeg per un crop che varia nel tempo (`crops`), usando trim+crop+scale
 * PER SEGMENTO seguito da un `concat`, invece di un'unica espressione ffmpeg "a tratti" (tipo
 * `if(lt(t,...),...)`) valutata da un solo filtro `crop` per l'intera durata.
 *
 * NECESSARIO, non solo uno stile diverso: verificato empiricamente (vedi debug di sessione,
 * root-caused isolando lo stesso filtro fuori dalla pipeline completa) che il parser di
 * espressioni di ffmpeg per i parametri w/h/x/y del filtro `crop`, quando l'espressione ha più
 * di ~3-4 diramazioni annidate E convive nello stesso grafo con un'altra espressione complessa
 * (qui: lo zoom EDL), può valutare SILENZIOSAMENTE MALE alcuni rami — nessun errore/warning,
 * solo un crop finito nel posto sbagliato del frame. La soglia esatta si è rivelata instabile e
 * dipendente da fattori non completamente isolati (persino il valore di un ramo MAI raggiunto
 * per il tempo testato cambiava l'esito), quindi non esiste un limite "sicuro" affidabile da
 * imporre lato nostro: trim+crop+concat usa SOLO numeri costanti nei parametri del filtro crop
 * (zero espressioni), quindi non può incappare in questo bug qualunque sia il numero di
 * segmenti — lo zoom resta un'unica espressione applicata DOPO il concat, sulla timeline
 * continua ricostruita (concat riallinea i PTS in modo che `t` coincida di nuovo con quello
 * della clip originale).
 */
function buildCroppedSteps(
  crops: TimedCrop[],
  totalDuration: number,
  outputWidth: number,
  outputHeight: number,
  label: string,
): string[] {
  const filled = fillCropGaps(crops, totalDuration);
  const collapsed = collapseIdenticalCrops(filled);

  if (collapsed.length === 1) {
    const c = collapsed[0]!.crop;
    return [`[0:v]crop=w=${c.width}:h=${c.height}:x=${c.x}:y=${c.y},scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1[${label}]`];
  }

  const steps: string[] = [];
  const segLabels: string[] = [];
  collapsed.forEach((seg, i) => {
    const segLabel = `${label}seg${i}`;
    const c = seg.crop;
    steps.push(
      `[0:v]trim=start=${seg.startSeconds.toFixed(3)}:end=${seg.endSeconds.toFixed(3)},setpts=PTS-STARTPTS,` +
        `crop=w=${c.width}:h=${c.height}:x=${c.x}:y=${c.y},scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1[${segLabel}]`,
    );
    segLabels.push(`[${segLabel}]`);
  });
  steps.push(`${segLabels.join("")}concat=n=${collapsed.length}:v=1:a=0[${label}]`);
  return steps;
}

/**
 * Riempie eventuali buchi in `crops` (es. Layout "mixed": `splitCrops` copre solo le finestre
 * eligible) in modo che l'array copra [0, totalDuration] SENZA buchi, riusando il crop più
 * vicino per riempire — necessario per trim+concat (serve una sequenza contigua), il valore
 * usato nel buco non è comunque mai visibile (quelle finestre non vengono sovrapposte nel
 * render, vedi Layout "mixed").
 */
function fillCropGaps(crops: TimedCrop[], totalDuration: number): TimedCrop[] {
  if (crops.length === 0) {
    throw new Error("fillCropGaps: nessun segmento di crop fornito");
  }
  const sorted = [...crops].sort((a, b) => a.startSeconds - b.startSeconds);
  const filled: TimedCrop[] = [];
  let cursor = 0;

  for (const c of sorted) {
    if (c.startSeconds > cursor + GAP_EPSILON_SECONDS) {
      filled.push({ startSeconds: cursor, endSeconds: c.startSeconds, crop: c.crop });
    }
    const start = Math.max(cursor, c.startSeconds);
    if (c.endSeconds > start + GAP_EPSILON_SECONDS) {
      filled.push({ startSeconds: start, endSeconds: c.endSeconds, crop: c.crop });
    }
    cursor = Math.max(cursor, c.endSeconds);
  }
  if (cursor < totalDuration - GAP_EPSILON_SECONDS) {
    filled.push({ startSeconds: cursor, endSeconds: totalDuration, crop: sorted[sorted.length - 1]!.crop });
  }
  // L'ultimo segmento deve combaciare ESATTAMENTE con totalDuration (trim non deve lasciare un
  // ultimo frammento scoperto per un residuo di arrotondamento).
  const last = filled[filled.length - 1];
  if (last) filled[filled.length - 1] = { ...last, endSeconds: totalDuration };
  return filled;
}

/** Unisce segmenti consecutivi con lo STESSO CropWindow (x,y,width,height) in un solo blocco. */
function collapseIdenticalCrops(crops: TimedCrop[]): TimedCrop[] {
  const result: TimedCrop[] = [];
  for (const c of crops) {
    const last = result[result.length - 1];
    if (last && cropsEqual(last.crop, c.crop)) {
      result[result.length - 1] = { ...last, endSeconds: c.endSeconds };
    } else {
      result.push(c);
    }
  }
  return result;
}

function cropsEqual(a: CropWindow, b: CropWindow): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function evenRound(value: number): number {
  return Math.round(value / 2) * 2;
}
