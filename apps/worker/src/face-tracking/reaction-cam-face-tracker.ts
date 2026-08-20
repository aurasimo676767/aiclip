import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import type { FaceTracker, Layout } from "./face-tracker.js";
import { extractRawFrameBGR } from "./frame-extractor.js";
import { detectFaces, type FaceBox } from "./onnx-face-detector.js";
import { centeredCrop, subjectCentricCrop } from "./crop-geometry.js";
import { CenterCropFaceTracker } from "./center-crop-face-tracker.js";
import { logger } from "../lib/logger.js";

const SAMPLE_COUNT = 6;
const MIN_STABLE_RATIO = 0.5; // il cluster deve comparire in almeno metà dei sample con un volto
const WEBCAM_MAX_AREA_RATIO = 0.05; // il volto occupa <5% dell'area del frame
const WEBCAM_CENTER_MARGIN = 0.3; // centro del volto fuori dal 30%-70% centrale (orizz. o vert.)
const WEBCAM_PADDING_FACTOR = 3.2; // quanto "allargare" il crop attorno al volto — più basso = più primo piano
const TOP_RATIO = 0.35; // frazione di altezza dedicata alla webcam nel layout split

interface Cluster {
  boxes: FaceBox[];
  sampleIndices: Set<number>;
}

/**
 * FaceTracker che usa rilevamento volto reale (ONNX, vedi onnx-face-detector.ts) su alcuni
 * frame campionati della clip per decidere il layout del crop verticale:
 *
 * - Se trova uno o più volti piccoli e stabili vicino a un bordo/angolo (tipico di una
 *   webcam in sovraimpressione su gameplay/video reagito), produce un layout split_vertical:
 *   SOLO il volto più stabile va in alto (mai più di una webcam anche con più speaker), il
 *   contenuto principale in basso resta sempre centrato orizzontalmente sul frame intero
 *   (mai su un volto, per non tagliare fuori il gameplay/video reagito).
 * - Se trova un volto stabile ma "normale" (centrale, non piccolo), centra il crop su di
 *   esso invece che sul centro geometrico del frame.
 * - Se non trova nessun volto stabile, ricade su `CenterCropFaceTracker`.
 *
 * Euristica, non un vero riconoscimento di "finestra webcam": funziona bene per il caso
 * comune (bolla fissa in un angolo) ma può sbagliare con overlay non standard.
 */
export class ReactionCamFaceTracker implements FaceTracker {
  private readonly fallback = new CenterCropFaceTracker();

  async computeLayout(params: {
    sourceVideoPath: string;
    sourceWidth: number;
    sourceHeight: number;
    startSeconds: number;
    endSeconds: number;
  }): Promise<Layout> {
    const { sourceVideoPath, sourceWidth, sourceHeight, startSeconds, endSeconds } = params;

    let samples: FaceBox[][];
    try {
      samples = await this.sampleDetections(sourceVideoPath, sourceWidth, sourceHeight, startSeconds, endSeconds);
    } catch (err) {
      logger.warn("Face detection fallita, fallback a crop centrato", {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.fallback.computeLayout(params);
    }

    const framesWithDetection = samples.filter((s) => s.length > 0).length;
    if (framesWithDetection === 0) {
      return this.fallback.computeLayout(params);
    }

    const clusters = clusterDetections(samples);
    const minCount = Math.max(1, Math.ceil(framesWithDetection * MIN_STABLE_RATIO));
    const stable = clusters.filter((c) => c.sampleIndices.size >= minCount);

    if (stable.length === 0) {
      return this.fallback.computeLayout(params);
    }

    const withMeta = stable.map((c) => ({ cluster: c, avg: averageBox(c.boxes), count: c.sampleIndices.size }));

    // Tra tutti i volti "tipo webcam" (piccoli, vicino a un bordo), tieni SOLO il più stabile
    // (rilevato nel maggior numero di campioni) — mai più di una webcam nel layout, anche se
    // il video ne mostra più d'una (es. duo streamer): mostriamo solo chi è più costantemente
    // inquadrato, a parità scegliendo il volto più piccolo/ravvicinato.
    const webcamCandidate = withMeta
      .filter(({ avg }) => isWebcamLike(avg, sourceWidth, sourceHeight))
      .sort((a, b) => b.count - a.count || areaRatio(a.avg, sourceWidth, sourceHeight) - areaRatio(b.avg, sourceWidth, sourceHeight))[0];

    if (!webcamCandidate) {
      // Nessun pattern "webcam in un angolo": centra semplicemente sul volto stabile più prominente.
      const primary = withMeta.sort((a, b) => b.count - a.count || b.avg.width * b.avg.height - a.avg.width * a.avg.height)[0];
      if (!primary) return this.fallback.computeLayout(params);
      const targetAspect = OUTPUT_RESOLUTION.width / OUTPUT_RESOLUTION.height;
      const cx = primary.avg.x + primary.avg.width / 2;
      const cy = primary.avg.y + primary.avg.height / 2;
      return { type: "single", crop: centeredCrop(cx, cy, sourceWidth, sourceHeight, targetAspect) };
    }

    const topAspect = OUTPUT_RESOLUTION.width / (OUTPUT_RESOLUTION.height * TOP_RATIO);
    const bottomAspect = OUTPUT_RESOLUTION.width / (OUTPUT_RESOLUTION.height * (1 - TOP_RATIO));

    const top = subjectCentricCrop(webcamCandidate.avg, sourceWidth, sourceHeight, topAspect, WEBCAM_PADDING_FACTOR);
    // Il contenuto principale (gameplay/video reagito) resta SEMPRE centrato orizzontalmente
    // sul frame intero: non va mai centrato su un volto (altrimenti, se c'è un secondo volto
    // altrove nel frame — es. un secondo streamer, o un personaggio nel gioco stesso — il
    // gameplay vero e proprio finisce fuori inquadratura invece di stare al centro).
    const bottom = centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, bottomAspect);

    logger.info("Layout reaction-cam rilevato", {
      webcam: webcamCandidate.avg,
      framesConfirmed: webcamCandidate.count,
      totalSamples: samples.length,
    });

    return { type: "split_vertical", top, bottom, topRatio: TOP_RATIO };
  }

  private async sampleDetections(
    videoPath: string,
    sourceWidth: number,
    sourceHeight: number,
    startSeconds: number,
    endSeconds: number,
  ): Promise<FaceBox[][]> {
    const duration = Math.max(0.1, endSeconds - startSeconds);
    const timestamps: number[] = [];
    for (let i = 1; i <= SAMPLE_COUNT; i++) {
      timestamps.push(startSeconds + (duration * i) / (SAMPLE_COUNT + 1));
    }

    const results: FaceBox[][] = [];
    for (const t of timestamps) {
      const frame = await extractRawFrameBGR(videoPath, t);
      const faces = await detectFaces(frame, sourceWidth, sourceHeight);
      results.push(faces);
    }
    return results;
  }
}

/** Clustering greedy: ogni box viene assegnato al cluster più vicino (centro entro soglia), uno per sample. */
function clusterDetections(samples: FaceBox[][]): Cluster[] {
  const clusters: Cluster[] = [];

  samples.forEach((boxes, sampleIndex) => {
    for (const box of boxes) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;

      let bestCluster: Cluster | null = null;
      let bestDist = Infinity;
      for (const cluster of clusters) {
        if (cluster.sampleIndices.has(sampleIndex)) continue; // un solo box per sample per cluster
        const avg = averageBox(cluster.boxes);
        const acx = avg.x + avg.width / 2;
        const acy = avg.y + avg.height / 2;
        const dist = Math.hypot(cx - acx, cy - acy);
        const threshold = Math.max(avg.width, box.width) * 0.75;
        if (dist < threshold && dist < bestDist) {
          bestDist = dist;
          bestCluster = cluster;
        }
      }

      if (bestCluster) {
        bestCluster.boxes.push(box);
        bestCluster.sampleIndices.add(sampleIndex);
      } else {
        clusters.push({ boxes: [box], sampleIndices: new Set([sampleIndex]) });
      }
    }
  });

  return clusters;
}

function averageBox(boxes: FaceBox[]): FaceBox {
  const n = boxes.length;
  const sum = boxes.reduce(
    (acc, b) => ({ x: acc.x + b.x, y: acc.y + b.y, width: acc.width + b.width, height: acc.height + b.height, score: acc.score + b.score }),
    { x: 0, y: 0, width: 0, height: 0, score: 0 },
  );
  return { x: sum.x / n, y: sum.y / n, width: sum.width / n, height: sum.height / n, score: sum.score / n };
}

function areaRatio(box: FaceBox, sourceWidth: number, sourceHeight: number): number {
  return (box.width * box.height) / (sourceWidth * sourceHeight);
}

function isWebcamLike(box: FaceBox, sourceWidth: number, sourceHeight: number): boolean {
  if (areaRatio(box, sourceWidth, sourceHeight) >= WEBCAM_MAX_AREA_RATIO) return false;
  const ncx = (box.x + box.width / 2) / sourceWidth;
  const ncy = (box.y + box.height / 2) / sourceHeight;
  const offCenterX = ncx < WEBCAM_CENTER_MARGIN || ncx > 1 - WEBCAM_CENTER_MARGIN;
  const offCenterY = ncy < WEBCAM_CENTER_MARGIN || ncy > 1 - WEBCAM_CENTER_MARGIN;
  return offCenterX || offCenterY;
}
