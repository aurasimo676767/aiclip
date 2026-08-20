import type { FaceTracker, Layout } from "./face-tracker.js";
import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import { centeredCrop } from "./crop-geometry.js";

/**
 * Implementazione di fallback: crop 9:16 centrato orizzontalmente sul frame, altezza piena,
 * statico per l'intera durata della clip. Nessun rilevamento volto reale — usata quando
 * `ReactionCamFaceTracker` non trova nessun volto nella clip (es. contenuto puramente
 * visivo, gameplay senza webcam).
 */
export class CenterCropFaceTracker implements FaceTracker {
  async computeLayout(params: { sourceWidth: number; sourceHeight: number; startSeconds: number; endSeconds: number }): Promise<Layout> {
    const targetAspect = OUTPUT_RESOLUTION.width / OUTPUT_RESOLUTION.height;
    const crop = centeredCrop(params.sourceWidth / 2, params.sourceHeight / 2, params.sourceWidth, params.sourceHeight, targetAspect);
    return {
      type: "single",
      crops: [{ startSeconds: 0, endSeconds: params.endSeconds - params.startSeconds, crop }],
    };
  }
}
