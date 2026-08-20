import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import type { CropWindow, FaceTracker, Layout, TimedCrop } from "./face-tracker.js";
import { extractRawFrameBGR } from "./frame-extractor.js";
import { detectFaces, type FaceBox } from "./onnx-face-detector.js";
import { centeredCrop, subjectCentricCrop } from "./crop-geometry.js";
import { CenterCropFaceTracker } from "./center-crop-face-tracker.js";
import { logger } from "../lib/logger.js";

const SEGMENT_LENGTH_SECONDS = 6;
const MAX_SEGMENTS = 5;
const SAMPLES_PER_SEGMENT = 3;

const MIN_STABLE_RATIO = 0.5; // il cluster deve comparire in almeno metà dei sample (del segmento) con un volto
const WEBCAM_MAX_AREA_RATIO = 0.05; // il volto occupa <5% dell'area del frame
const WEBCAM_CENTER_MARGIN = 0.3; // centro del volto fuori dal 30%-70% centrale (orizz. o vert.)
const WEBCAM_PADDING_FACTOR = 2.6; // quanto "allargare" il crop attorno al volto — basso = primo piano stretto, meno sfondo/gioco visibile
const TOP_RATIO = 0.35; // frazione di altezza dedicata alla webcam nel layout split

interface Cluster {
  boxes: FaceBox[];
  sampleIndices: Set<number>;
}

interface SegmentDecision {
  startSeconds: number; // clip-relative
  endSeconds: number;
  webcamCrop: CropWindow | null;
  singleCrop: CropWindow; // sempre disponibile: face-centrato se trovato un volto, altrimenti centro geometrico
}

/**
 * FaceTracker che usa rilevamento volto reale (ONNX, vedi onnx-face-detector.ts), campionato
 * su più segmenti temporali della clip (non un solo blocco statico), per seguire un feed
 * webcam che può cambiare posizione/persona durante la clip:
 *
 * - Divide la clip in alcuni segmenti (~6s l'uno) e per ciascuno rileva indipendentemente i
 *   volti presenti.
 * - Se ALMENO UN segmento mostra un volto piccolo e stabile vicino a un bordo (tipico di una
 *   webcam in sovraimpressione), l'intera clip usa un layout split_vertical: la webcam in
 *   alto segue il crop segmento per segmento (per i segmenti senza rilevamento, riusa la
 *   posizione del segmento valido più vicino); il contenuto principale in basso resta
 *   SEMPRE centrato orizzontalmente sul frame intero, mai su un volto — altrimenti un
 *   secondo speaker/personaggio nel gioco stesso "ruberebbe" lo spazio al gameplay vero.
 * - Se non trova mai un pattern webcam, centra semplicemente il crop sul volto più prominente
 *   di ciascun segmento (o sul centro geometrico se nessun volto è mai rilevato).
 *
 * Euristica, non un vero riconoscimento di "finestra webcam": funziona bene per il caso
 * comune (bolla fissa in un angolo, anche se il feed attivo cambia) ma può sbagliare con
 * overlay non standard.
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
    const clipDuration = Math.max(0.1, endSeconds - startSeconds);

    const segmentCount = Math.min(MAX_SEGMENTS, Math.max(1, Math.round(clipDuration / SEGMENT_LENGTH_SECONDS)));
    const segmentLength = clipDuration / segmentCount;

    const decisions: SegmentDecision[] = [];
    for (let i = 0; i < segmentCount; i++) {
      const segStart = i * segmentLength;
      const segEnd = (i + 1) * segmentLength;
      try {
        const decision = await this.decideSegment(sourceVideoPath, sourceWidth, sourceHeight, startSeconds + segStart, startSeconds + segEnd);
        decisions.push({ startSeconds: segStart, endSeconds: segEnd, ...decision });
      } catch (err) {
        logger.warn("Face detection fallita per un segmento, uso crop centrato per quel tratto", {
          error: err instanceof Error ? err.message : String(err),
        });
        const targetAspect = OUTPUT_RESOLUTION.width / OUTPUT_RESOLUTION.height;
        decisions.push({
          startSeconds: segStart,
          endSeconds: segEnd,
          webcamCrop: null,
          singleCrop: centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, targetAspect),
        });
      }
    }

    const anyWebcam = decisions.some((d) => d.webcamCrop !== null);

    if (!anyWebcam) {
      const anyFaceFound = decisions.some((d) => d.singleCrop);
      if (!anyFaceFound) return this.fallback.computeLayout(params);
      return {
        type: "single",
        crops: decisions.map((d) => ({ startSeconds: d.startSeconds, endSeconds: d.endSeconds, crop: d.singleCrop })),
      };
    }

    // Segmenti senza webcam rilevata: riusano la posizione del segmento valido più vicino,
    // così la webcam non "sparisce" per un tratto in cui il rilevamento è fallito per caso.
    const topCrops: TimedCrop[] = decisions.map((d, i) => ({
      startSeconds: d.startSeconds,
      endSeconds: d.endSeconds,
      crop: d.webcamCrop ?? nearestWebcamCrop(decisions, i),
    }));

    const bottomAspect = OUTPUT_RESOLUTION.width / (OUTPUT_RESOLUTION.height * (1 - TOP_RATIO));
    const bottom = centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, bottomAspect);

    logger.info("Layout reaction-cam (dinamico) rilevato", { segments: segmentCount, withWebcam: decisions.filter((d) => d.webcamCrop).length });

    return { type: "split_vertical", topCrops, bottom, topRatio: TOP_RATIO };
  }

  /** Rileva i volti in un singolo segmento temporale e decide il crop per QUEL segmento. */
  private async decideSegment(
    videoPath: string,
    sourceWidth: number,
    sourceHeight: number,
    absStart: number,
    absEnd: number,
  ): Promise<{ webcamCrop: CropWindow | null; singleCrop: CropWindow }> {
    const duration = Math.max(0.1, absEnd - absStart);
    const timestamps: number[] = [];
    for (let i = 1; i <= SAMPLES_PER_SEGMENT; i++) {
      timestamps.push(absStart + (duration * i) / (SAMPLES_PER_SEGMENT + 1));
    }

    const samples: FaceBox[][] = [];
    for (const t of timestamps) {
      const frame = await extractRawFrameBGR(videoPath, t);
      samples.push(await detectFaces(frame, sourceWidth, sourceHeight));
    }

    const targetAspect = OUTPUT_RESOLUTION.width / OUTPUT_RESOLUTION.height;
    const framesWithDetection = samples.filter((s) => s.length > 0).length;
    if (framesWithDetection === 0) {
      return { webcamCrop: null, singleCrop: centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, targetAspect) };
    }

    const clusters = clusterDetections(samples);
    const minCount = Math.max(1, Math.ceil(framesWithDetection * MIN_STABLE_RATIO));
    const stable = clusters.filter((c) => c.sampleIndices.size >= minCount);

    if (stable.length === 0) {
      return { webcamCrop: null, singleCrop: centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, targetAspect) };
    }

    const withMeta = stable.map((c) => ({ avg: averageBox(c.boxes), count: c.sampleIndices.size }));

    const webcamCandidate = withMeta
      .filter(({ avg }) => isWebcamLike(avg, sourceWidth, sourceHeight))
      .sort((a, b) => b.count - a.count || areaRatio(a.avg, sourceWidth, sourceHeight) - areaRatio(b.avg, sourceWidth, sourceHeight))[0];

    const primary = withMeta.sort((a, b) => b.count - a.count || b.avg.width * b.avg.height - a.avg.width * a.avg.height)[0];
    const primaryCx = primary ? primary.avg.x + primary.avg.width / 2 : sourceWidth / 2;
    const primaryCy = primary ? primary.avg.y + primary.avg.height / 2 : sourceHeight / 2;
    const singleCrop = centeredCrop(primaryCx, primaryCy, sourceWidth, sourceHeight, targetAspect);

    if (!webcamCandidate) {
      return { webcamCrop: null, singleCrop };
    }

    const topAspect = OUTPUT_RESOLUTION.width / (OUTPUT_RESOLUTION.height * TOP_RATIO);
    const webcamCrop = subjectCentricCrop(webcamCandidate.avg, sourceWidth, sourceHeight, topAspect, WEBCAM_PADDING_FACTOR);

    return { webcamCrop, singleCrop };
  }
}

/** Trova il crop webcam del segmento valido più vicino (prima prova indietro, poi avanti). */
function nearestWebcamCrop(decisions: SegmentDecision[], fromIndex: number): CropWindow {
  for (let offset = 1; offset < decisions.length; offset++) {
    const before = decisions[fromIndex - offset];
    if (before?.webcamCrop) return before.webcamCrop;
    const after = decisions[fromIndex + offset];
    if (after?.webcamCrop) return after.webcamCrop;
  }
  // Non dovrebbe succedere (chiamata solo quando anyWebcam è true), ma un fallback safe non guasta.
  const fallback = decisions.find((d) => d.webcamCrop)?.webcamCrop;
  return fallback ?? decisions[fromIndex]!.singleCrop;
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
