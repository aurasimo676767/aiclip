import type { CropWindow, FaceTracker } from "./face-tracker.js";
import { OUTPUT_RESOLUTION } from "@clipforge/shared";

/**
 * Implementazione di default: crop 9:16 centrato orizzontalmente sul frame, altezza piena.
 * Nessun rilevamento volto reale — funziona bene per inquadrature già centrate (webcam singola,
 * podcast a camera fissa) ma può tagliare soggetti fuori centro in inquadrature larghe/multi-speaker.
 *
 * Manca: un vero face detector (es. un modello ONNX/mediapipe eseguito per-frame o a campionamento)
 * che sposti dinamicamente il crop per seguire lo speaker attivo. L'interfaccia FaceTracker è
 * pensata apposta per inserirlo in futuro senza toccare edl-executor.ts o render.ts.
 */
export class CenterCropFaceTracker implements FaceTracker {
  async computeCropWindow(params: {
    sourceWidth: number;
    sourceHeight: number;
    startSeconds: number;
    endSeconds: number;
  }): Promise<CropWindow> {
    const targetAspect = OUTPUT_RESOLUTION.width / OUTPUT_RESOLUTION.height; // 9/16

    const { sourceWidth, sourceHeight } = params;
    const sourceAspect = sourceWidth / sourceHeight;

    if (sourceAspect > targetAspect) {
      // Sorgente più larga del target: crop orizzontale centrato, altezza piena.
      const cropWidth = Math.round(sourceHeight * targetAspect);
      const x = Math.round((sourceWidth - cropWidth) / 2);
      return { x, y: 0, width: cropWidth, height: sourceHeight };
    }

    // Sorgente più stretta/uguale al target (raro per video landscape): crop verticale centrato, larghezza piena.
    const cropHeight = Math.round(sourceWidth / targetAspect);
    const y = Math.round((sourceHeight - cropHeight) / 2);
    return { x: 0, y, width: sourceWidth, height: cropHeight };
  }
}
