import { extractRawFrameBGRScaled } from "./frame-extractor.js";
import { logger } from "../lib/logger.js";
import type { CropWindow } from "./face-tracker.js";

/** Risoluzione di analisi: serve solo la mappa di "dove cambia qualcosa", non il dettaglio. */
const ANALYSIS_WIDTH = 480;

/**
 * Frazione dell'attività totale che la finestra scelta deve contenere per essere preferita a un
 * ritaglio centrato. Se il contenuto è sparso su tutto lo schermo (gameplay a schermo intero),
 * nessuna finestra spicca davvero e tanto vale restare centrati.
 */
const MIN_ACTIVITY_SHARE = 0.55;

/** Passo della ricerca in pixel di analisi: 4px bastano, e tengono la scansione istantanea. */
const SEARCH_STEP = 4;

/** Quanta parte della finestra può sovrapporsi a una webcam: quella parte finisce sfocata nel render. */
const MAX_WEBCAM_OVERLAP_SHARE = 0.2;

/**
 * Trova la porzione di schermo dove sta davvero succedendo qualcosa, per inquadrare il pannello
 * "contenuto" lì invece che al centro geometrico del frame.
 *
 * Perché serve: il pannello contenuto era un ritaglio centrato del frame intero, e su una sorgente
 * dove il contenuto guardato non sta al centro (un TikTok dentro un browser, con metà schermo
 * occupato da commenti e barre) finiva per inquadrare per buona parte spazio morto — verificato su
 * un fotogramma reale.
 *
 * Come: il contenuto guardato/giocato CAMBIA di continuo, mentre la UI attorno (bordi del browser,
 * barre, bande nere, pannelli statici) resta identica. Sommando le differenze tra fotogrammi
 * successivi si ottiene una mappa di "attività", e si sceglie la finestra che ne racchiude di più.
 * Le zone delle webcam vengono azzerate: anche loro si muovono, ma non sono il contenuto.
 *
 * Se nessuna finestra si distingue abbastanza (tipico del gameplay a schermo intero, dove l'azione
 * è ovunque), ritorna null e il chiamante resta sul ritaglio centrato.
 */
export async function detectContentRegion(
  videoPath: string,
  sampleTimes: number[],
  sourceWidth: number,
  sourceHeight: number,
  targetAspect: number,
  excludeRegions: CropWindow[],
): Promise<CropWindow | null> {
  const scale = ANALYSIS_WIDTH / sourceWidth;
  const width = ANALYSIS_WIDTH;
  const height = Math.max(2, Math.round(sourceHeight * scale));

  const activity = await buildActivityMap(videoPath, sampleTimes, width, height);
  if (!activity) return null;

  // Le webcam si muovono quanto e più del contenuto: senza azzerarle, la finestra andrebbe a
  // cercarle invece del contenuto.
  for (const region of excludeRegions) {
    const x0 = Math.max(0, Math.floor(region.x * scale));
    const y0 = Math.max(0, Math.floor(region.y * scale));
    const x1 = Math.min(width - 1, Math.ceil((region.x + region.width) * scale));
    const y1 = Math.min(height - 1, Math.ceil((region.y + region.height) * scale));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) activity[y * width + x] = 0;
    }
  }

  // La finestra più grande con l'aspetto richiesto che sta nel frame (le stesse proporzioni del
  // pannello, così il ritaglio non deforma nulla).
  let windowWidth = width;
  let windowHeight = Math.round(windowWidth / targetAspect);
  if (windowHeight > height) {
    windowHeight = height;
    windowWidth = Math.round(windowHeight * targetAspect);
  }
  if (windowWidth >= width && windowHeight >= height) return null; // la finestra è già tutto il frame

  // Non si somma l'attività: si CONTA quanti pixel sono attivi. Un video in riproduzione è attivo
  // in modo uniforme su tutta la sua superficie, mentre una chat che scorre concentra tantissima
  // attività su poche righe di testo — sommando, la chat vinceva e la finestra andava lì
  // (verificato su un fotogramma reale). Contando i pixel, vince la zona attiva più estesa.
  const threshold = activeThreshold(activity);
  const activeMap = new Float32Array(activity.length);
  for (let i = 0; i < activity.length; i++) activeMap[i] = activity[i]! > threshold ? 1 : 0;

  const integral = buildIntegralImage(activeMap, width, height);
  const total = regionSum(integral, width, 0, 0, width - 1, height - 1);
  if (total <= 0) return null;

  // La finestra deve stare il più possibile FUORI dalle webcam: la parte che le si sovrappone
  // viene sfocata nel render (per non mostrare due volte la stessa persona), quindi sceglierne una
  // che ne copre metà significa riempire mezzo pannello di macchia sfocata — visto in pratica.
  const maxOverlap = windowWidth * windowHeight * MAX_WEBCAM_OVERLAP_SHARE;
  const excludeScaled = excludeRegions.map((r) => ({
    x0: r.x * scale,
    y0: r.y * scale,
    x1: (r.x + r.width) * scale,
    y1: (r.y + r.height) * scale,
  }));

  let best: { x: number; y: number; sum: number } | null = null;
  for (let y = 0; y + windowHeight <= height; y += SEARCH_STEP) {
    for (let x = 0; x + windowWidth <= width; x += SEARCH_STEP) {
      const overlap = excludeScaled.reduce(
        (acc, r) =>
          acc +
          Math.max(0, Math.min(x + windowWidth, r.x1) - Math.max(x, r.x0)) *
            Math.max(0, Math.min(y + windowHeight, r.y1) - Math.max(y, r.y0)),
        0,
      );
      if (overlap > maxOverlap) continue;

      const sum = regionSum(integral, width, x, y, x + windowWidth - 1, y + windowHeight - 1);
      if (!best || sum > best.sum) best = { x, y, sum };
    }
  }
  if (!best) return null;

  const share = best.sum / total;
  if (share < MIN_ACTIVITY_SHARE) {
    logger.info("Contenuto sparso su tutto il frame, resto sul ritaglio centrato", { share: share.toFixed(2) });
    return null;
  }

  const rect: CropWindow = {
    x: Math.round(best.x / scale),
    y: Math.round(best.y / scale),
    width: Math.round(windowWidth / scale),
    height: Math.round(windowHeight / scale),
  };
  logger.info("Regione di contenuto individuata", { rect, share: share.toFixed(2) });
  return rect;
}

/** Somma, pixel per pixel, quanto l'immagine cambia tra un campione e il successivo. */
async function buildActivityMap(
  videoPath: string,
  sampleTimes: number[],
  width: number,
  height: number,
): Promise<Float32Array | null> {
  const activity = new Float32Array(width * height);
  let previous: Float32Array | null = null;
  let pairs = 0;

  for (const t of sampleTimes) {
    let frame: Buffer;
    try {
      frame = await extractRawFrameBGRScaled(videoPath, t, width, height);
    } catch {
      continue;
    }
    if (frame.length < width * height * 3) continue;

    const luma = toLuma(frame, width, height);
    if (previous) {
      for (let i = 0; i < activity.length; i++) activity[i]! += Math.abs(luma[i]! - previous[i]!);
      pairs++;
    }
    previous = luma;
  }

  return pairs > 0 ? activity : null;
}

/**
 * Soglia oltre la quale un pixel conta come "attivo": una frazione del livello di attività alto
 * della scena (95° percentile), così si adatta a sorgenti più o meno mosse invece di dipendere da
 * un valore assoluto.
 */
function activeThreshold(activity: Float32Array): number {
  const sorted = Float32Array.from(activity).sort();
  const high = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  return high * 0.15;
}

function buildIntegralImage(values: Float32Array, width: number, height: number): Float64Array {
  // Una riga e una colonna in più di zeri, così le somme non hanno casi speciali ai bordi.
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += values[y * width + x]!;
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)]! + rowSum;
    }
  }
  return integral;
}

function regionSum(integral: Float64Array, width: number, x0: number, y0: number, x1: number, y1: number): number {
  const stride = width + 1;
  return (
    integral[(y1 + 1) * stride + (x1 + 1)]! -
    integral[y0 * stride + (x1 + 1)]! -
    integral[(y1 + 1) * stride + x0]! +
    integral[y0 * stride + x0]!
  );
}

function toLuma(bgr: Buffer, width: number, height: number): Float32Array {
  const luma = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 3;
    luma[i] = 0.114 * bgr[o]! + 0.587 * bgr[o + 1]! + 0.299 * bgr[o + 2]!;
  }
  return luma;
}

/**
 * Quanta parte dell'attività totale deve restare DENTRO il rettangolo scelto. Senza questo vincolo
 * vincerebbe sempre un francobollo iper-denso (il punto che si muove di più), non il blocco di
 * contenuto.
 */
const MIN_BOUNDS_ACTIVITY_SHARE = 0.35;

/** Sotto questa frazione di schermo il rettangolo non è credibile come "contenuto". */
const MIN_BOUNDS_SCREEN_SHARE = 0.04;

/** Passi della ricerca: pochi, la mappa di analisi è piccola e la scansione resta istantanea. */
const BOUNDS_SIZE_STEPS = 10;
const BOUNDS_POSITION_STEP = 6;

/**
 * I BORDI del contenuto in movimento, di proporzioni QUALSIASI — a differenza di
 * detectContentRegion, che cerca una finestra con le proporzioni del pannello di destinazione.
 *
 * Perché non basta quella: il vincolo di proporzione, su un pannello quasi quadrato, obbliga la
 * finestra a essere larga mezzo schermo anche quando il contenuto guardato è una colonna stretta.
 * Verificato su una reaction a Instagram dentro un browser: il pannello mostrava il reel a sinistra
 * e per il resto i commenti e la cornice del browser.
 *
 * Perché si massimizza la DENSITÀ di attività e non l'estensione: prendere il rettangolo che
 * contiene tutti i pixel attivi non funziona — provato, e su quella stessa reaction i commenti che
 * scorrono lo allargavano al 77% dello schermo, peggio di prima. Il contenuto vero è invece
 * attività FITTA su un'area compatta, mentre commenti e chat sono attività rada sparsa: a parità di
 * attività racchiusa vince quindi il rettangolo più piccolo che la contiene.
 *
 * Ritorna null se non ne esce niente di sensato: decide il chiamante.
 */
export async function detectContentBounds(
  videoPath: string,
  sampleTimes: number[],
  sourceWidth: number,
  sourceHeight: number,
  excludeRegions: CropWindow[],
): Promise<CropWindow | null> {
  const scale = ANALYSIS_WIDTH / sourceWidth;
  const width = ANALYSIS_WIDTH;
  const height = Math.max(2, Math.round(sourceHeight * scale));

  const activity = await buildActivityMap(videoPath, sampleTimes, width, height);
  if (!activity) return null;

  // Le webcam si muovono quanto e più del contenuto: senza azzerarle il rettangolo va su di loro.
  for (const region of excludeRegions) {
    const rx0 = Math.max(0, Math.floor(region.x * scale));
    const ry0 = Math.max(0, Math.floor(region.y * scale));
    const rx1 = Math.min(width - 1, Math.ceil((region.x + region.width) * scale));
    const ry1 = Math.min(height - 1, Math.ceil((region.y + region.height) * scale));
    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) activity[y * width + x] = 0;
    }
  }

  // Stessa scelta di detectContentRegion: si contano i pixel ATTIVI invece di sommare l'attività,
  // così una chat che scorre (tantissima attività su poche righe) non pesa più di un video in play.
  const threshold = activeThreshold(activity);
  const activeMap = new Float32Array(activity.length);
  for (let i = 0; i < activity.length; i++) activeMap[i] = activity[i]! > threshold ? 1 : 0;

  const integral = buildIntegralImage(activeMap, width, height);
  const total = regionSum(integral, width, 0, 0, width - 1, height - 1);
  if (total <= 0) return null;
  const required = total * MIN_BOUNDS_ACTIVITY_SHARE;

  let best: { x: number; y: number; w: number; h: number; density: number } | null = null;
  for (let wi = BOUNDS_SIZE_STEPS; wi >= 2; wi--) {
    const winWidth = Math.round((width * wi) / BOUNDS_SIZE_STEPS);
    for (let hi = BOUNDS_SIZE_STEPS; hi >= 2; hi--) {
      const winHeight = Math.round((height * hi) / BOUNDS_SIZE_STEPS);
      const area = winWidth * winHeight;
      // Un rettangolo più piccolo del migliore trovato non potrà batterlo in densità se non
      // racchiude comunque l'attività richiesta: il minimo resta `required`.
      if (best && required / area <= best.density && area < winWidth * winHeight) continue;
      for (let y = 0; y + winHeight <= height; y += BOUNDS_POSITION_STEP) {
        for (let x = 0; x + winWidth <= width; x += BOUNDS_POSITION_STEP) {
          const sum = regionSum(integral, width, x, y, x + winWidth - 1, y + winHeight - 1);
          if (sum < required) continue;
          const density = sum / area;
          if (!best || density > best.density) best = { x, y, w: winWidth, h: winHeight, density };
        }
      }
    }
  }
  if (!best) return null;

  const rect: CropWindow = {
    x: Math.max(0, Math.round(best.x / scale)),
    y: Math.max(0, Math.round(best.y / scale)),
    width: Math.min(sourceWidth, Math.round(best.w / scale)),
    height: Math.min(sourceHeight, Math.round(best.h / scale)),
  };
  const screenShare = (rect.width * rect.height) / (sourceWidth * sourceHeight);
  if (screenShare < MIN_BOUNDS_SCREEN_SHARE) return null;

  logger.info("Bordi del contenuto individuati", { rect, quotaSchermo: screenShare.toFixed(2) });
  return rect;
}
