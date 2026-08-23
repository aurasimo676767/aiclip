/** Rettangolo di crop in pixel, riferito ai frame del video sorgente. */
export interface CropWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Un crop valido solo per una finestra di tempo della clip (tempi CLIP-relativi, 0 = inizio clip). */
export interface TimedCrop {
  startSeconds: number;
  endSeconds: number;
  crop: CropWindow;
}

/**
 * Layout del crop verticale per una clip. Entrambe le varianti sono composte da uno o più
 * segmenti temporali (`TimedCrop[]`): se la webcam/lo speaker cambia posizione durante la
 * clip (es. il feed attivo passa da una persona all'altra), il crop la segue invece di
 * restare fisso su dove si trovava all'inizio.
 *
 * - "single": crop 9:16 che segue nel tempo lo speaker/soggetto principale.
 * - "split_vertical": due fasce impilate — webcam in alto (segue nel tempo), contenuto
 *   principale in basso (sempre centrato sul frame intero, mai su un volto — vedi
 *   reaction-cam-face-tracker.ts per il perché). `blurRegions` (coordinate del video
 *   sorgente) sono le zone note contenere una webcam reale: il contenuto in basso è un crop
 *   centrato dell'INTERO frame sorgente, quindi senza sfocarle mostrerebbe due volte la
 *   stessa webcam — una volta ravvicinata in alto, una volta piccola (e spesso tagliata) in
 *   basso, dentro l'area "contenuto".
 */
export type Layout =
  | { type: "single"; crops: TimedCrop[] }
  | { type: "split_vertical"; topCrops: TimedCrop[]; bottom: CropWindow; topRatio: number; blurRegions: CropWindow[] };

/**
 * Astrazione sul tracking di volto/speaker usato per decidere il layout del crop verticale.
 *
 * Implementazioni:
 * - `CenterCropFaceTracker`: crop centrato statico, nessun rilevamento reale (fallback).
 * - `ReactionCamFaceTracker`: rilevamento volto reale (ONNX, vedi onnx-face-detector.ts),
 *   campionato a intervalli lungo la clip, con euristica per riconoscere un layout
 *   "reaction cam" (webcam piccola in un angolo, separata dal contenuto principale) e
 *   costruire uno split-screen che segue la webcam attiva nel tempo.
 */
export interface FaceTracker {
  computeLayout(params: {
    sourceVideoPath: string;
    sourceWidth: number;
    sourceHeight: number;
    /** Timestamp assoluti sul video sorgente (stessa timeline del transcript). */
    startSeconds: number;
    endSeconds: number;
  }): Promise<Layout>;
}
