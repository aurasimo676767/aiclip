/** Rettangolo di crop in pixel, riferito ai frame del video sorgente. */
export interface CropWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Layout del crop verticale per una clip:
 * - "single": un solo crop 9:16 (caso normale, uno speaker/soggetto).
 * - "split_vertical": due crop impilati (es. webcam in alto, contenuto principale in
 *   basso) — usato per contenuti "reaction"/gaming dove uno speaker reagisce a un video
 *   in 16:9 tramite una webcam in sovraimpressione.
 */
export type Layout =
  | { type: "single"; crop: CropWindow }
  | { type: "split_vertical"; top: CropWindow; bottom: CropWindow; topRatio: number };

/**
 * Astrazione sul tracking di volto/speaker usato per decidere il layout del crop verticale.
 *
 * Implementazioni:
 * - `CenterCropFaceTracker`: crop centrato statico, nessun rilevamento reale (fallback).
 * - `ReactionCamFaceTracker`: rilevamento volto reale (ONNX, vedi onnx-face-detector.ts) +
 *   euristica per riconoscere un layout "reaction cam" (webcam piccola in un angolo,
 *   separata dal contenuto principale) e costruire uno split-screen.
 */
export interface FaceTracker {
  computeLayout(params: {
    sourceVideoPath: string;
    sourceWidth: number;
    sourceHeight: number;
    startSeconds: number;
    endSeconds: number;
  }): Promise<Layout>;
}
