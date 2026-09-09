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
 * Layout del crop verticale per una clip. Due sole varianti, entrambe volutamente STATICHE
 * nell'inquadratura: nessuno zoom, nessun crop che insegue un volto nel tempo.
 *
 * Le versioni precedenti seguivano il volto ricalcolando il crop ogni secondo (con media mobile
 * per smussare) e passavano a un primo piano a schermo intero nei momenti di reazione forte. In
 * pratica il risultato era un'inquadratura che non stava mai ferma — il rilevatore sposta il
 * riquadro di qualche pixel a ogni campionamento anche su una persona immobile, e il crop
 * inseguiva quel rumore — e un primo piano quasi mai centrato bene. Rimosso del tutto.
 *
 * - "scenes": una composizione FISSA PER OGNI SCENA del montaggio originale. Usato quando la clip
 *   non ha un'unica webcam fissa per tutta la durata. Molti VOD non sono stream grezzi ma video
 *   GIÀ MONTATI, che staccano ogni pochi secondi fra streamer a schermo intero, gameplay a schermo
 *   intero e condivisione schermo con la cam in un angolo: una composizione sola non può andare
 *   bene per tutte e tre — verificato su una clip reale, ne usciva il gioco ingrandito e tagliato
 *   per l'intera durata. Ogni scena sceglie quindi la sua (vedi SceneComposition), e i confini
 *   coincidono con gli STACCHI veri del montaggio (scene-detect.ts), così il cambio cade dove lo
 *   spettatore già se lo aspetta invece di sembrare un movimento.
 * - "split_vertical": due fasce impilate — webcam in alto, contenuto principale in basso. Il
 *   contenuto è un crop STATICO centrato del frame intero (mai centrato su un volto, mai
 *   zoomato). `topCrops` è una sequenza temporale solo perché la webcam mostrata cambia quando
 *   cambia CHI PARLA: dentro il turno di una stessa persona il crop resta identico, quindi lo
 *   stacco è un taglio netto e non un movimento continuo. `blurRegions` (coordinate del video
 *   sorgente) sono le zone note contenere una webcam: il pannello in basso è un crop dell'INTERO
 *   frame, quindi senza sfocarle mostrerebbe due volte la stessa webcam — una in alto e una
 *   piccola (spesso tagliata) dentro l'area "contenuto".
 */
/**
 * Come si compone UNA scena. Tre casi, che coprono quello che si trova davvero in un VOD montato:
 *
 * - "crop": ritaglio 9:16 del frame sorgente. Per le scene con un soggetto a schermo intero:
 *   riempie lo schermo e la persona resta centrata.
 * - "fit": il frame sorgente INTERO, rimpicciolito al centro, con sopra e sotto lo stesso frame
 *   sfocato a riempire. Per il gameplay a schermo intero senza nessuna cam: ritagliarlo a 9:16
 *   butterebbe via due terzi dell'immagine, e cosa serve vedere dipende dal gioco — un ritaglio
 *   "sull'azione" indovina, questo non deve indovinare niente.
 * - "split": il template — cam sopra, contenuto sotto. Per le scene con la cam in un angolo
 *   (tipicamente condivisione schermo), che senza questo finivano ritagliate a caso.
 */
export type SceneComposition =
  | { kind: "crop"; crop: CropWindow }
  | { kind: "fit" }
  | { kind: "split"; cam: CropWindow; content: CropWindow; topRatio: number };

export interface Scene {
  startSeconds: number;
  endSeconds: number;
  composition: SceneComposition;
}

export type Layout =
  | { type: "scenes"; scenes: Scene[] }
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
