import type { CropWindow } from "./face-tracker.js";

/** Il più grande rettangolo con `targetAspect` (w/h) centrato su (cx,cy), interamente dentro i bound sorgente. */
export function centeredCrop(
  cx: number,
  cy: number,
  sourceWidth: number,
  sourceHeight: number,
  targetAspect: number,
): CropWindow {
  const sourceAspect = sourceWidth / sourceHeight;

  let width: number;
  let height: number;
  if (sourceAspect > targetAspect) {
    height = sourceHeight;
    width = Math.round(height * targetAspect);
  } else {
    width = sourceWidth;
    height = Math.round(width / targetAspect);
  }

  const x = clamp(Math.round(cx - width / 2), 0, sourceWidth - width);
  const y = clamp(Math.round(cy - height / 2), 0, sourceHeight - height);

  return { x, y, width, height };
}

/**
 * Crop con `targetAspect` dimensionato attorno a un soggetto (es. un volto) con un
 * margine di padding, invece di occupare tutta l'altezza/larghezza sorgente — usato per
 * "zoomare" su una regione piccola (es. la bolla di una webcam) invece di centrare un
 * crop a piena altezza come `centeredCrop`.
 */
// I rilevatori di volti restituiscono un riquadro STRETTO (circa sopracciglia-mento), che
// NON include fronte/capelli sopra — quasi niente serve invece sotto il mento. Centrare il
// padding simmetricamente sul riquadro spreca metà del margine sotto il mento e ne lascia
// troppo poco sopra la testa: nei segmenti con un riquadro rilevato un po' più piccolo del
// solito, questo faceva tagliare la cima della testa. Ancoriamo quindi il centro verticale
// più in basso nel riquadro (vicino agli occhi, non al centro geometrico) così una quota
// maggiore del padding va sopra.
const VERTICAL_ANCHOR_RATIO = 0.35; // frazione dall'alto del riquadro volto usata come "centro" verticale

export function subjectCentricCrop(
  subject: { x: number; y: number; width: number; height: number },
  sourceWidth: number,
  sourceHeight: number,
  targetAspect: number,
  paddingFactor: number,
): CropWindow {
  const cx = subject.x + subject.width / 2;
  const cy = subject.y + subject.height * VERTICAL_ANCHOR_RATIO;

  let height = Math.min(sourceHeight, subject.height * paddingFactor);
  let width = height * targetAspect;
  if (width > sourceWidth) {
    width = sourceWidth;
    height = width / targetAspect;
  }

  const x = clamp(Math.round(cx - width / 2), 0, sourceWidth - width);
  const y = clamp(Math.round(cy - height / 2), 0, sourceHeight - height);

  return { x, y, width: Math.round(width), height: Math.round(height) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
