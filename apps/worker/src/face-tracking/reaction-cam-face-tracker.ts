import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import type { CropWindow, FaceTracker, Layout, TimedCrop } from "./face-tracker.js";
import { extractRawFrameBGR } from "./frame-extractor.js";
import { detectFaces, type FaceBox } from "./onnx-face-detector.js";
import { computeMouthMotion } from "./mouth-motion.js";
import { centeredCrop, subjectCentricCrop } from "./crop-geometry.js";
import { CenterCropFaceTracker } from "./center-crop-face-tracker.js";
import { logger } from "../lib/logger.js";

const SEGMENT_LENGTH_SECONDS = 6;
const MAX_SEGMENTS = 5;
const SAMPLES_PER_SEGMENT = 3;
const MOTION_FRAME_DELAY_SECONDS = 0.15; // distanza tra i due frame usati per stimare il movimento della bocca

const MIN_STABLE_RATIO = 0.5; // il cluster deve comparire in almeno metà dei sample (del segmento) con un volto
const WEBCAM_MAX_AREA_RATIO = 0.05; // il volto occupa <5% dell'area del frame
const WEBCAM_CENTER_MARGIN = 0.3; // centro del volto fuori dal 30%-70% centrale (orizz. o vert.)
const WEBCAM_PADDING_FACTOR = 2.6; // quanto "allargare" il crop attorno al volto — basso = primo piano stretto, meno sfondo/gioco visibile
const SINGLE_FACE_PADDING_FACTOR = 7; // idem, ma per il layout "schermo intero": più margine (testa+spalle+contesto), non un primissimo piano
const TOP_RATIO = 0.35; // frazione di altezza dedicata alla webcam nel layout split
const MOTION_NOISE_FLOOR = 4; // sotto questa soglia il "movimento" è rumore/compressione, non parlato reale

interface DetectionEntry {
  box: FaceBox;
  motion: number;
}

interface Cluster {
  entries: DetectionEntry[];
  sampleIndices: Set<number>;
}

interface ClusterMeta {
  avg: FaceBox;
  count: number;
  motion: number;
}

interface SegmentDecision {
  startSeconds: number; // clip-relative
  endSeconds: number;
  webcamCrop: CropWindow | null;
  singleCrop: CropWindow; // sempre disponibile: face-centrato se trovato un volto, altrimenti centro geometrico
}

/** Risultato grezzo di un segmento, prima della selezione dell'ancora cross-segmento. */
interface SegmentDetections {
  startSeconds: number;
  endSeconds: number;
  webcamCandidates: ClusterMeta[]; // tutti i volti "webcam-like" trovati in QUESTO segmento, non ancora filtrati
  singleCrop: CropWindow;
}

const MIN_ANCHOR_SEGMENT_COVERAGE_RATIO = 0.4; // un volto deve ricomparire in almeno questa frazione dei segmenti per essere considerato "la webcam reale" e non un volto di passaggio nel contenuto reagito

/**
 * FaceTracker che usa rilevamento volto reale (ONNX, vedi onnx-face-detector.ts), campionato
 * su più segmenti temporali della clip, per seguire chi sta effettivamente parlando:
 *
 * - Divide la clip in alcuni segmenti (~6s l'uno) e per ciascuno rileva indipendentemente i
 *   volti presenti, stimando anche il movimento della bocca di ciascuno (vedi
 *   mouth-motion.ts) per distinguere chi sta parlando da chi sta solo ascoltando quando più
 *   webcam sono visibili insieme nello stesso momento.
 * - Se un segmento mostra un volto piccolo vicino a un bordo (tipico di una webcam in
 *   sovraimpressione), l'intera clip usa un layout split_vertical: la webcam in alto segue
 *   il crop segmento per segmento (per i segmenti senza rilevamento, riusa la posizione del
 *   segmento valido più vicino); il contenuto principale in basso resta SEMPRE centrato
 *   orizzontalmente sul frame intero, mai su un volto.
 * - Prima di scegliere la webcam per ogni segmento, i volti "webcam-like" vengono raggruppati
 *   per POSIZIONE attraverso TUTTI i segmenti: solo un volto che ricompare nella stessa zona
 *   dello schermo in più segmenti viene considerato "la webcam reale" (un overlay fisso resta
 *   fermo nel tempo). Un volto che appare solo in un segmento isolato — tipicamente qualcuno
 *   inquadrato DENTRO il video reagito, non chi sta reagendo — viene scartato come "ancora",
 *   anche se in quel singolo segmento sembrava webcam-like: altrimenti finiva per rubare il
 *   posto alla vera webcam del reactor quando parlava più forte/muoveva di più la bocca.
 * - Se non trova mai un pattern webcam, centra il crop sul volto più prominente di ciascun
 *   segmento (per prominente si intende: chi parla di più, non semplicemente chi è più
 *   stabile/grande — a parità di movimento, vince stabilità poi dimensione).
 *
 * Euristica, non un vero riconoscimento "chi sta parlando": funziona bene per il caso comune
 * ma può sbagliare con inquadrature molto ravvicinate o webcam di bassa qualità/frame rate.
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

    const rawSegments: SegmentDetections[] = [];
    for (let i = 0; i < segmentCount; i++) {
      const segStart = i * segmentLength;
      const segEnd = (i + 1) * segmentLength;
      try {
        const detections = await this.detectSegment(sourceVideoPath, sourceWidth, sourceHeight, startSeconds + segStart, startSeconds + segEnd);
        rawSegments.push({ startSeconds: segStart, endSeconds: segEnd, ...detections });
      } catch (err) {
        logger.warn("Face detection fallita per un segmento, uso crop centrato per quel tratto", {
          error: err instanceof Error ? err.message : String(err),
        });
        const targetAspect = OUTPUT_RESOLUTION.width / OUTPUT_RESOLUTION.height;
        rawSegments.push({
          startSeconds: segStart,
          endSeconds: segEnd,
          webcamCandidates: [],
          singleCrop: centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, targetAspect),
        });
      }
    }

    const decisions: SegmentDecision[] = this.resolveWebcamAnchors(rawSegments, segmentCount, sourceWidth, sourceHeight);

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

  /**
   * Rileva i volti in un singolo segmento temporale. Ritorna TUTTI i candidati "webcam-like"
   * trovati (non ancora ridotti a uno solo: la scelta finale considera anche gli altri
   * segmenti, vedi resolveWebcamAnchors) più lo speaker principale del segmento per il
   * layout "single" a schermo intero.
   */
  private async detectSegment(
    videoPath: string,
    sourceWidth: number,
    sourceHeight: number,
    absStart: number,
    absEnd: number,
  ): Promise<{ webcamCandidates: ClusterMeta[]; singleCrop: CropWindow }> {
    const duration = Math.max(0.1, absEnd - absStart);
    const timestamps: number[] = [];
    for (let i = 1; i <= SAMPLES_PER_SEGMENT; i++) {
      timestamps.push(absStart + (duration * i) / (SAMPLES_PER_SEGMENT + 1));
    }

    const samples: DetectionEntry[][] = [];
    for (const t of timestamps) {
      const frameA = await extractRawFrameBGR(videoPath, t);
      const boxes = await detectFaces(frameA, sourceWidth, sourceHeight);
      if (boxes.length === 0) {
        samples.push([]);
        continue;
      }
      // Il secondo frame serve solo a stimare il movimento: se fallisce (es. sample troppo
      // vicino alla fine del video), i volti restano comunque validi con motion=0.
      let frameB: Buffer | null = null;
      try {
        frameB = await extractRawFrameBGR(videoPath, t + MOTION_FRAME_DELAY_SECONDS);
      } catch {
        frameB = null;
      }
      samples.push(
        boxes.map((box) => ({
          box,
          motion: frameB ? computeMouthMotion(frameA, frameB, box, sourceWidth, sourceHeight) : 0,
        })),
      );
    }

    const targetAspect = OUTPUT_RESOLUTION.width / OUTPUT_RESOLUTION.height;
    const framesWithDetection = samples.filter((s) => s.length > 0).length;
    if (framesWithDetection === 0) {
      return { webcamCandidates: [], singleCrop: centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, targetAspect) };
    }

    const clusters = clusterDetections(samples);
    const minCount = Math.max(1, Math.ceil(framesWithDetection * MIN_STABLE_RATIO));
    const stable = clusters.filter((c) => c.sampleIndices.size >= minCount);

    if (stable.length === 0) {
      return { webcamCandidates: [], singleCrop: centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, targetAspect) };
    }

    const withMeta: ClusterMeta[] = stable.map((c) => ({
      avg: averageBox(c.entries.map((e) => e.box)),
      count: c.sampleIndices.size,
      motion: c.entries.reduce((sum, e) => sum + e.motion, 0) / c.entries.length,
    }));

    const primary = selectBest(withMeta);
    // Crop centrato attorno alla persona (con margine per testa/spalle), NON forzato a piena
    // altezza sorgente: usare sempre piena altezza include qualunque cosa stia sopra/sotto il
    // volto (barra del browser, bordi neri, altre finestre) quando la webcam non riempie
    // davvero l'intero frame sorgente — da qui gli "spezzoni" visti in alto nel crop.
    const singleCrop = primary
      ? subjectCentricCrop(primary.avg, sourceWidth, sourceHeight, targetAspect, SINGLE_FACE_PADDING_FACTOR)
      : centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, targetAspect);

    const webcamCandidates = withMeta.filter((m) => isWebcamLike(m.avg, sourceWidth, sourceHeight));

    return { webcamCandidates, singleCrop };
  }

  /**
   * Sceglie, per ogni segmento, quale volto "webcam-like" è davvero la webcam del reactor —
   * usando la persistenza della posizione ATTRAVERSO i segmenti, non il singolo segmento
   * isolato. Un overlay reale resta (circa) nello stesso punto dello schermo per tutta la
   * clip; un volto che appare dentro il contenuto reagito (es. il video che si sta guardando)
   * compare tipicamente in un solo segmento e sparisce. Solo i volti che ricompaiono in più
   * segmenti diventano "ancore" valide; tra più ancore nello stesso segmento (vera webcam
   * doppia/duo) si sceglie comunque in base al movimento della bocca, come prima.
   */
  private resolveWebcamAnchors(
    rawSegments: SegmentDetections[],
    segmentCount: number,
    sourceWidth: number,
    sourceHeight: number,
  ): SegmentDecision[] {
    const allCandidates: Array<{ segIndex: number; meta: ClusterMeta }> = [];
    rawSegments.forEach((seg, segIndex) => {
      for (const meta of seg.webcamCandidates) {
        allCandidates.push({ segIndex, meta });
      }
    });

    const minAnchorCoverage = segmentCount <= 2 ? 1 : Math.max(2, Math.ceil(segmentCount * MIN_ANCHOR_SEGMENT_COVERAGE_RATIO));
    const anchorGroups = clusterByPosition(allCandidates).filter((g) => g.segIndices.size >= minAnchorCoverage);

    const topAspect = OUTPUT_RESOLUTION.width / (OUTPUT_RESOLUTION.height * TOP_RATIO);

    return rawSegments.map((seg) => {
      const anchoredHere = seg.webcamCandidates.filter((m) => anchorGroups.some((g) => isNearBox(m.avg, g.avg)));
      const chosen = selectBest(anchoredHere);
      return {
        startSeconds: seg.startSeconds,
        endSeconds: seg.endSeconds,
        webcamCrop: chosen ? subjectCentricCrop(chosen.avg, sourceWidth, sourceHeight, topAspect, WEBCAM_PADDING_FACTOR) : null,
        singleCrop: seg.singleCrop,
      };
    });
  }
}

/**
 * Sceglie il "migliore" tra più cluster candidati: se qualcuno si muove chiaramente più
 * degli altri (sta parlando), vince quello. Altrimenti (tutti fermi/silenzio, o differenze
 * nel rumore) si torna al criterio precedente: più stabile, poi più grande.
 */
function selectBest(list: ClusterMeta[], filter?: (m: ClusterMeta) => boolean): ClusterMeta | undefined {
  const candidates = filter ? list.filter(filter) : list;
  if (candidates.length === 0) return undefined;

  const maxMotion = Math.max(...candidates.map((c) => c.motion));
  if (maxMotion > MOTION_NOISE_FLOOR) {
    return [...candidates].sort((a, b) => b.motion - a.motion || b.count - a.count)[0];
  }
  return [...candidates].sort((a, b) => b.count - a.count || b.avg.width * b.avg.height - a.avg.width * a.avg.height)[0];
}

/** Trova il crop webcam del segmento valido più vicino (prima prova indietro, poi avanti). */
function nearestWebcamCrop(decisions: SegmentDecision[], fromIndex: number): CropWindow {
  for (let offset = 1; offset < decisions.length; offset++) {
    const before = decisions[fromIndex - offset];
    if (before?.webcamCrop) return before.webcamCrop;
    const after = decisions[fromIndex + offset];
    if (after?.webcamCrop) return after.webcamCrop;
  }
  const fallback = decisions.find((d) => d.webcamCrop)?.webcamCrop;
  return fallback ?? decisions[fromIndex]!.singleCrop;
}

interface PositionGroup {
  avg: FaceBox;
  segIndices: Set<number>;
  entries: FaceBox[];
}

/**
 * Raggruppa candidati "webcam-like" per posizione ATTRAVERSO i segmenti (a differenza di
 * clusterDetections, che raggruppa le rilevazioni DENTRO un singolo segmento): serve a capire
 * quale volto è un overlay persistente (la vera webcam) e quale è comparso solo di passaggio.
 */
function clusterByPosition(items: Array<{ segIndex: number; meta: ClusterMeta }>): PositionGroup[] {
  const groups: PositionGroup[] = [];

  for (const { segIndex, meta } of items) {
    let bestGroup: PositionGroup | null = null;
    let bestDist = Infinity;
    for (const group of groups) {
      if (group.segIndices.has(segIndex)) continue; // un solo volto per segmento per gruppo
      const dist = boxDistance(meta.avg, group.avg);
      const threshold = Math.max(group.avg.width, meta.avg.width) * 0.75;
      if (dist < threshold && dist < bestDist) {
        bestDist = dist;
        bestGroup = group;
      }
    }
    if (bestGroup) {
      bestGroup.entries.push(meta.avg);
      bestGroup.segIndices.add(segIndex);
      bestGroup.avg = averageBox(bestGroup.entries);
    } else {
      groups.push({ avg: meta.avg, segIndices: new Set([segIndex]), entries: [meta.avg] });
    }
  }

  return groups;
}

function isNearBox(a: FaceBox, b: FaceBox): boolean {
  return boxDistance(a, b) < Math.max(a.width, b.width) * 0.75;
}

function boxDistance(a: FaceBox, b: FaceBox): number {
  const acx = a.x + a.width / 2;
  const acy = a.y + a.height / 2;
  const bcx = b.x + b.width / 2;
  const bcy = b.y + b.height / 2;
  return Math.hypot(acx - bcx, acy - bcy);
}

/** Clustering greedy: ogni rilevazione viene assegnata al cluster più vicino (centro entro soglia), una per sample. */
function clusterDetections(samples: DetectionEntry[][]): Cluster[] {
  const clusters: Cluster[] = [];

  samples.forEach((entries, sampleIndex) => {
    for (const entry of entries) {
      const cx = entry.box.x + entry.box.width / 2;
      const cy = entry.box.y + entry.box.height / 2;

      let bestCluster: Cluster | null = null;
      let bestDist = Infinity;
      for (const cluster of clusters) {
        if (cluster.sampleIndices.has(sampleIndex)) continue; // una sola rilevazione per sample per cluster
        const avg = averageBox(cluster.entries.map((e) => e.box));
        const acx = avg.x + avg.width / 2;
        const acy = avg.y + avg.height / 2;
        const dist = Math.hypot(cx - acx, cy - acy);
        const threshold = Math.max(avg.width, entry.box.width) * 0.75;
        if (dist < threshold && dist < bestDist) {
          bestDist = dist;
          bestCluster = cluster;
        }
      }

      if (bestCluster) {
        bestCluster.entries.push(entry);
        bestCluster.sampleIndices.add(sampleIndex);
      } else {
        clusters.push({ entries: [entry], sampleIndices: new Set([sampleIndex]) });
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
