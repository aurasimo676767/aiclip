import type { CropWindow, Layout, Scene, SceneComposition, TimedCrop } from "../face-tracking/face-tracker.js";
import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import { toFfmpegFilterPath } from "./ffmpeg-filter-utils.js";

export interface VideoFilterParams {
  layout: Layout;
  assSubtitlesPath: string;
  showProgressBar: boolean;
  clipDurationSeconds: number;
}

/**
 * Costruisce la catena di filtri video ffmpeg per una clip:
 * composizione verticale (crop statico a schermo intero, oppure webcam sopra + contenuto sotto)
 * -> sottotitoli bruciati (ASS) -> progress bar opzionale. Ritorna la stringa da passare a
 * `-filter_complex`, con output finale su label `[vout]`.
 *
 * Nessuno zoom in nessuna delle due composizioni: gli eventi "zoom"/"punch_in" dell'EDL non
 * vengono più applicati al video. L'inquadratura del contenuto resta identica per tutta la clip
 * (richiesta esplicita: il gioco/la reaction devono stare fermi), e la webcam cambia solo con
 * uno stacco netto quando cambia chi parla.
 */
export function buildVideoFilterComplex(params: VideoFilterParams): string {
  const { layout, assSubtitlesPath, showProgressBar, clipDurationSeconds } = params;

  const steps = layout.type === "scenes" ? buildScenesSteps(layout.scenes, clipDurationSeconds) : buildSplitVerticalSteps(layout, clipDurationSeconds);

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

/**
 * Ogni scena viene composta come un pezzo INDIPENDENTE già a piena canvas verticale, e i pezzi
 * vengono poi concatenati. Così scene composte in modi diversi (ritaglio, frame intero su sfondo
 * sfocato, cam sopra + contenuto sotto) convivono nella stessa clip senza che nessuna debba
 * adattarsi alle altre: il concat richiede solo che abbiano tutte la stessa dimensione di uscita.
 *
 * Come per i crop a tratti (vedi buildCroppedSteps) qui non c'è NESSUNA espressione dipendente da
 * `t` nei parametri dei filtri: ogni pezzo usa solo numeri costanti, quindi non può incappare nel
 * bug di valutazione del parser di espressioni di ffmpeg.
 */
function buildScenesSteps(scenes: Scene[], totalDuration: number): string[] {
  const steps: string[] = [];
  const outLabels: string[] = [];

  scenes.forEach((scene, i) => {
    const src = `sc${i}src`;
    const out = `sc${i}out`;
    const start = Math.max(0, scene.startSeconds);
    const end = i === scenes.length - 1 ? Math.max(start + 0.01, totalDuration) : scene.endSeconds;
    steps.push(`[0:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS[${src}]`);
    steps.push(...buildCompositionSteps(scene.composition, src, out, `sc${i}`));
    outLabels.push(`[${out}]`);
  });

  if (outLabels.length === 1) {
    // Un pezzo solo: il concat sarebbe inutile, e rinominare la label basta.
    steps.push(`${outLabels[0]}null[scaled]`);
    return steps;
  }
  steps.push(`${outLabels.join("")}concat=n=${outLabels.length}:v=1:a=0[scaled]`);
  return steps;
}

/** Porta un pezzo di scena da `inLabel` a `outLabel`, a piena canvas verticale. */
function buildCompositionSteps(composition: SceneComposition, inLabel: string, outLabel: string, prefix: string): string[] {
  const { width: W, height: H } = OUTPUT_RESOLUTION;

  if (composition.kind === "crop") {
    const c = composition.crop;
    return [`[${inLabel}]crop=w=${c.width}:h=${c.height}:x=${c.x}:y=${c.y},scale=${W}:${H}:flags=lanczos,setsar=1[${outLabel}]`];
  }

  if (composition.kind === "fit") {
    // Frame intero rimpicciolito al centro; dietro, lo stesso frame allargato fino a coprire tutta
    // la canvas e sfocato. Lo sfondo sfocato (invece di due bande nere) tiene lo sguardo dentro
    // l'immagine e non lascia due buchi neri su un telefono.
    return [
      `[${inLabel}]split=2[${prefix}fg][${prefix}bgsrc]`,
      `[${prefix}bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bilinear,crop=${W}:${H},` +
        `boxblur=${FIT_BACKGROUND_BLUR_PX}:2,setsar=1[${prefix}bg]`,
      `[${prefix}fg]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[${prefix}fgs]`,
      `[${prefix}bg][${prefix}fgs]overlay=(W-w)/2:(H-h)/2[${outLabel}]`,
    ];
  }

  const topHeight = evenRound(H * composition.topRatio);
  const bottomHeight = H - topHeight;
  const cam = composition.cam;
  const content = composition.content;
  const blur = intersectCropWithBottom(cam, content);
  const steps = [
    `[${inLabel}]split=2[${prefix}camsrc][${prefix}consrc]`,
    `[${prefix}camsrc]crop=w=${cam.width}:h=${cam.height}:x=${cam.x}:y=${cam.y},` +
      `scale=${W}:${topHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${topHeight},setsar=1[${prefix}top]`,
    `[${prefix}consrc]crop=w=${content.width}:h=${content.height}:x=${content.x}:y=${content.y}[${prefix}con]`,
  ];

  let last = `${prefix}con`;
  if (blur) {
    // Il crop "contenuto" può contenere di nuovo la cam già mostrata sopra: la sfochiamo.
    steps.push(`[${last}]split=2[${last}k][${last}s]`);
    steps.push(`[${last}s]crop=w=${blur.width}:h=${blur.height}:x=${blur.x}:y=${blur.y},boxblur=${blurRadiusFor(blur)}:3[${prefix}patch]`);
    steps.push(`[${last}k][${prefix}patch]overlay=${blur.x}:${blur.y}[${prefix}conb]`);
    last = `${prefix}conb`;
  }
  steps.push(
    `[${last}]scale=${W}:${bottomHeight}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${W}:${bottomHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[${prefix}bottom]`,
    `[${prefix}top][${prefix}bottom]vstack=inputs=2[${outLabel}]`,
  );
  return steps;
}

/**
 * Sfocatura dello sfondo nella composizione "fit". Abbastanza forte da non competere con
 * l'immagine nitida davanti, abbastanza leggera da restare riconoscibile come continuazione
 * della scena e non come una macchia.
 */
const FIT_BACKGROUND_BLUR_PX = 20;

function buildSplitVerticalSteps(layout: Extract<Layout, { type: "split_vertical" }>, totalDuration: number, prefix = ""): string[] {
  const topHeight = evenRound(OUTPUT_RESOLUTION.height * layout.topRatio);
  const bottomHeight = OUTPUT_RESOLUTION.height - topHeight;
  const { topCrops, bottom, blurRegions } = layout;

  // Webcam a RIEMPIRE il pannello, senza bande nere: l'altezza del pannello è già calcolata dalle
  // proporzioni del riquadro webcam rilevato (vedi topRatioForWebcam), quindi qui resta al massimo
  // una differenza di pochi pixel da rifilare. Prima si usava "contieni e centra", che con una
  // webcam di forma diversa dal pannello lasciava bande spesse sopra e sotto — brutte in uno Short.
  const topSteps = buildCroppedSteps(topCrops, totalDuration, OUTPUT_RESOLUTION.width, topHeight, `${prefix}top`, "cover");

  const steps = [
    // Webcam: cambia solo quando cambia chi parla (stacco netto), nessuno zoom.
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
    steps.push(
      `[${lastLabel}_src]crop=w=${region.width}:h=${region.height}:x=${region.x}:y=${region.y},` +
        `boxblur=${blurRadiusFor(region)}:3[${patchLabel}]`,
    );
    steps.push(`[${lastLabel}_keep][${patchLabel}]overlay=${region.x}:${region.y}[${nextLabel}]`);
    lastLabel = nextLabel;
  });

  // Contenuto: scalato e basta, nessuno zoom — l'inquadratura del gioco/della reaction resta
  // identica per tutta la clip.
  steps.push(
    `[${lastLabel}]scale=${OUTPUT_RESOLUTION.width}:${bottomHeight}:flags=lanczos,setsar=1[${prefix}bottom]`,
    `[${prefix}top][${prefix}bottom]vstack=inputs=2[${prefix}scaled]`,
  );

  return steps;
}

// Sotto questa soglia (px) una regione da sfocare viene scartata: una striscia sottile di webcam
// che sborda nel pannello contenuto non vale la pena di essere sfocata, e ritagli minuscoli
// creano solo problemi al filtro (vedi blurRadiusFor).
const MIN_BLUR_REGION_PX = 16;

/** Raggio massimo di boxblur, usato quando la regione è abbastanza grande da reggerlo. */
const MAX_BLUR_RADIUS_PX = 24;

/**
 * Raggio di sfocatura compatibile con la dimensione della regione: ffmpeg rifiuta un boxblur il
 * cui raggio superi metà del lato più corto ("Failed to configure input pad on Parsed_boxblur",
 * render fallito). Bug reale osservato su una clip vera, dove la webcam sbordava nel pannello
 * contenuto per soli 13 pixel e il raggio fisso di 24 faceva fallire l'intero render.
 *
 * Si divide per QUATTRO e non per due perché boxblur applica lo stesso raggio anche ai piani di
 * CROMINANZA, che in yuv420p sono grandi la metà: su una regione di 36px il raggio 17 passava il
 * controllo sulla luminanza e veniva poi rifiutato con "Invalid chroma_param radius value 17, must
 * be >= 0 and < 9". Questo era anche il crash "Error reinitializing filters!" che faceva fallire il
 * render di una clip senza spiegazione apparente: l'errore arriva a fine configurazione del
 * filtergraph, quindi il messaggio utile scorre via in mezzo agli altri.
 */
function blurRadiusFor(region: CropWindow): number {
  const maxForRegion = Math.floor(Math.min(region.width, region.height) / 4) - 1;
  return Math.max(1, Math.min(MAX_BLUR_RADIUS_PX, maxForRegion));
}

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
  mode: "fill" | "cover" = "fill",
): string[] {
  const filled = fillCropGaps(crops, totalDuration);
  const collapsed = collapseIdenticalCrops(filled);

  // "cover": l'immagine viene ingrandita finché COPRE tutto il riquadro e poi rifilata al centro —
  // riempie sempre, senza bande nere e senza deformare, al costo di qualche pixel tagliato sul lato
  // più lungo. "fill": scalata esattamente alle dimensioni richieste (il crop ha già le proporzioni
  // giuste, quindi non deforma).
  const scaleFilter =
    mode === "cover"
      ? `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase:flags=lanczos,` +
        `crop=${outputWidth}:${outputHeight},setsar=1`
      : `scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1`;

  if (collapsed.length === 1) {
    const c = collapsed[0]!.crop;
    return [`[0:v]crop=w=${c.width}:h=${c.height}:x=${c.x}:y=${c.y},${scaleFilter}[${label}]`];
  }

  const steps: string[] = [];
  const segLabels: string[] = [];
  collapsed.forEach((seg, i) => {
    const segLabel = `${label}seg${i}`;
    const c = seg.crop;
    steps.push(
      `[0:v]trim=start=${seg.startSeconds.toFixed(3)}:end=${seg.endSeconds.toFixed(3)},setpts=PTS-STARTPTS,` +
        `crop=w=${c.width}:h=${c.height}:x=${c.x}:y=${c.y},${scaleFilter}[${segLabel}]`,
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
