/** Rettangolo di crop in pixel, riferito ai frame del video sorgente. */
export interface CropWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Astrazione sul tracking di volto/speaker usato per centrare il crop verticale 9:16.
 *
 * Fase 1: implementazione di default `CenterCropFaceTracker`, che centra staticamente
 * il crop sul frame senza rilevamento volto reale (vedi commento nel file).
 *
 * Sostituibile in futuro con un tracker basato su un modello ML (es. face detection +
 * tracking per-frame, o diarizzazione audio/video per capire chi parla in ogni istante)
 * implementando la stessa interfaccia: il resto della pipeline di render dipende solo
 * da `computeCropWindow`.
 */
export interface FaceTracker {
  /**
   * Calcola la finestra di crop 9:16 da applicare al video sorgente per l'intervallo
   * [startSeconds, endSeconds]. Può ritornare una finestra statica o una funzione del tempo;
   * in Fase 1 ritorniamo sempre una finestra statica per clip.
   */
  computeCropWindow(params: {
    sourceWidth: number;
    sourceHeight: number;
    startSeconds: number;
    endSeconds: number;
  }): Promise<CropWindow>;
}
