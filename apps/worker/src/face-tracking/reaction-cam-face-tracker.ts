import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import type { CropWindow, FaceTracker, Layout, TimedCrop } from "./face-tracker.js";
import { extractRawFrameBGR } from "./frame-extractor.js";
import { detectFaces, type FaceBox } from "./onnx-face-detector.js";
import { computeMouthMotion } from "./mouth-motion.js";
import { centeredCrop, subjectCentricCrop, maxSymmetricCropHeight } from "./crop-geometry.js";
import { CenterCropFaceTracker } from "./center-crop-face-tracker.js";
import { logger } from "../lib/logger.js";

const SEGMENT_LENGTH_SECONDS = 2; // prima 6: un editor umano cambia inquadratura ogni 1-2s, non ogni 6
const MAX_SEGMENTS = 30; // alzato in proporzione: senza questo, per clip di 20-60s il cap dominava comunque e SEGMENT_LENGTH_SECONDS più basso non aveva alcun effetto reale
const SAMPLES_PER_SEGMENT = 5; // prima 3: verificato su un video reale (4 persone in call) che le webcam più piccole/meno nitide dei partecipanti minori venivano rilevate in una minoranza dei campioni, sparendo dai candidati di interi segmenti anche se stavano parlando
const MOTION_FRAME_DELAY_SECONDS = 0.15; // distanza tra i due frame usati per stimare il movimento della bocca

const MIN_STABLE_RATIO = 0.5; // il cluster deve comparire in almeno metà dei sample (del segmento) con un volto
const WEBCAM_MAX_AREA_RATIO = 0.05; // il volto occupa <5% dell'area del frame
const WEBCAM_CENTER_MARGIN = 0.3; // centro del volto fuori dal 30%-70% centrale (orizz. o vert.)
const WEBCAM_PADDING_FACTOR = 2.6; // quanto "allargare" il crop attorno al volto — basso = primo piano stretto, meno sfondo/gioco visibile
const SINGLE_FACE_PADDING_FACTOR = 7; // idem, ma per il layout "schermo intero": più margine (testa+spalle+contesto), non un primissimo piano
const TOP_RATIO = 0.35; // frazione di altezza dedicata alla webcam nel layout split
const MOTION_NOISE_FLOOR = 4; // sotto questa soglia il "movimento" è rumore/compressione, non parlato reale
const BLUR_REGION_PADDING_FACTOR = 4; // margine generoso: l'overlay webcam reale è quasi sempre più grande del solo riquadro del volto rilevato, meglio sfocare un po' di più che lasciare una fetta visibile
const BACKGROUND_FILL_TRIGGER_RATIO = 0.55; // sotto questa frazione di sourceHeight, il volto è DAVVERO spostato verso un bordo (non solo leggermente sopra/sotto il centro): verificato su un video reale con inquadratura moderatamente decentrata (rapporto ~0.75, già validata come accettabile) che NON deve attivare lo sfondo — solo un decentramento più marcato (webcam grande ma vicina a un bordo, es. rapporto ~0.5) lo giustifica
const SINGLE_CROP_SMOOTHING_ALPHA = 0.4; // solo per il layout "schermo intero" (una persona zoomata): quanto peso dare al nuovo segmento vs quello smussato precedente — basso = più morbido ma più lento a inseguire un movimento reale, alto = più reattivo ma più "a scatti"
const SMOOTHING_CUT_HEIGHT_RATIO = 1.6; // se l'altezza raw del segmento cambia di più di questo fattore rispetto allo smoothed corrente, non è rumore da smussare ma un vero cambio di inquadratura (es. l'OBS della sorgente passa da una webcam piccola in un angolo a una grande centrale) — verificato su un caso reale dove un volto minuscolo nei primi 2 segmenti faceva impiegare 8 segmenti (16s, più di metà clip) all'EMA per raggiungere l'inquadratura vera, dando la sensazione di uno zoom che continua ad "aggiustarsi" invece di un taglio netto
const SMOOTHING_CUT_CENTER_RATIO = 0.25; // idem per lo spostamento del centro, come frazione della diagonale del frame sorgente
const MIN_CONSECUTIVE_MISSES_TO_SWITCH = 2; // segmenti di fila SENZA un'ancora webcam genuina (non riusata da un vicino) prima di considerare la scena sorgente davvero cambiata invece di un semplice miss isolato del detector — verificato su un caso reale (streamer che passa da "webcam piccola + TikTok reagito" a "solo webcam a schermo intero" e poi a un layout diverso ancora dentro la STESSA clip): un singolo segmento perso viene ancora riusato dal vicino più vicino (comportamento invariato), ma 2+ di fila passano al layout "mixed" invece di forzare uno split_vertical ormai senza senso in quel tratto

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
  singleCropNeedsFill: boolean; // vedi SegmentDetections.singleCropNeedsFill
}

/** Risultato grezzo di un segmento, prima della selezione dell'ancora cross-segmento. */
interface SegmentDetections {
  startSeconds: number;
  endSeconds: number;
  webcamCandidates: ClusterMeta[]; // tutti i volti "webcam-like" trovati in QUESTO segmento, non ancora filtrati
  singleCrop: CropWindow;
  /**
   * True se il volto scelto per singleCrop era troppo grande/decentrato per un crop centrato
   * "a piena inquadratura" (il padding desiderato eccedeva l'altezza sorgente) — segnale che il
   * layout "single" per l'intera clip dovrebbe usare uno sfondo sfocato invece di stirare il
   * crop fino ai bordi sorgente (vedi Layout.backgroundFill in face-tracker.ts).
   */
  singleCropNeedsFill: boolean;
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
          singleCropNeedsFill: false,
        });
      }
    }

    const { decisions, anchorGroups } = this.resolveWebcamAnchors(rawSegments, segmentCount, sourceWidth, sourceHeight);

    const anyWebcam = decisions.some((d) => d.webcamCrop !== null);

    const targetAspect = OUTPUT_RESOLUTION.width / OUTPUT_RESOLUTION.height;

    const buildSingleCrops = (): { crops: TimedCrop[]; backgroundFill: boolean } => {
      const smoothedCrops = smoothCropSequence(
        decisions.map((d) => d.singleCrop),
        targetAspect,
        sourceWidth,
        sourceHeight,
      );
      // Maggioranza dei segmenti, non "almeno uno": un singolo segmento atipico (es. un volto
      // minuscolo per un paio di secondi a inizio clip, prima che inquadratura si stabilizzi)
      // non deve trascinare l'intera clip in modalità sfondo sfocato se per il resto della
      // durata il volto è ragionevolmente centrato e il crop a piena canvas va già bene.
      const backgroundFill = decisions.filter((d) => d.singleCropNeedsFill).length > decisions.length / 2;
      return {
        crops: decisions.map((d, i) => ({ startSeconds: d.startSeconds, endSeconds: d.endSeconds, crop: smoothedCrops[i]! })),
        backgroundFill,
      };
    };

    if (!anyWebcam) {
      const anyFaceFound = decisions.some((d) => d.singleCrop);
      if (!anyFaceFound) return this.fallback.computeLayout(params);
      const { crops, backgroundFill } = buildSingleCrops();
      return { type: "single", crops, backgroundFill };
    }

    // Un'ancora è valida per l'intera clip (webcamCrop non-null da resolveWebcamAnchors), ma
    // qui distinguiamo un match GENUINO per QUESTO segmento specifico (il detector ha trovato
    // davvero quell'ancora in quel tratto) da un semplice buco riempito riusando il vicino più
    // vicino — 2+ buchi genuini di fila non sono più "rumore del detector", sono il segnale che
    // la scena sorgente è cambiata (vedi MIN_CONSECUTIVE_MISSES_TO_SWITCH).
    const genuineMatch = decisions.map((d) => d.webcamCrop !== null);
    const splitEligible = smoothEligibility(genuineMatch);
    const anyEligible = splitEligible.some(Boolean);
    const allEligible = splitEligible.every(Boolean);

    const bottomAspect = OUTPUT_RESOLUTION.width / (OUTPUT_RESOLUTION.height * (1 - TOP_RATIO));
    const bottom = centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, bottomAspect);
    // Ogni ancora valida è, per definizione, un overlay webcam fisso nel frame sorgente — e
    // il pannello "contenuto" sotto è un crop dell'INTERO frame sorgente, quindi la mostra
    // di nuovo, piccola (e spesso tagliata dal bordo del crop). Sfochiamo quelle zone nel
    // rendering invece di lasciarle visibili due volte.
    const blurRegions: CropWindow[] = anchorGroups.map((g) => subjectCentricCrop(g.avg, sourceWidth, sourceHeight, 1, BLUR_REGION_PADDING_FACTOR));

    if (!anyEligible) {
      // Ogni match trovato era un miss isolato circondato da buchi sostenuti (es. un'ancora
      // vista solo per un paio di segmenti su tutta la clip): non è un vero pattern reaction-cam
      // sostenuto, meglio trattare l'intera clip come "single".
      const { crops, backgroundFill } = buildSingleCrops();
      logger.info("Layout reaction-cam: pattern webcam non sostenuto, uso single per l'intera clip", { segments: segmentCount });
      return { type: "single", crops, backgroundFill };
    }

    // Segmenti senza webcam rilevata (ma "eligible", cioè miss isolato): riusano la posizione
    // del segmento valido più vicino, così la webcam non "sparisce" per un tratto in cui il
    // rilevamento è fallito per caso.
    const topCrops: TimedCrop[] = decisions.map((d, i) => ({
      startSeconds: d.startSeconds,
      endSeconds: d.endSeconds,
      crop: d.webcamCrop ?? nearestWebcamCrop(decisions, i),
    }));

    if (allEligible) {
      logger.info("Layout reaction-cam (dinamico) rilevato", {
        segments: segmentCount,
        withWebcam: decisions.filter((d) => d.webcamCrop).length,
        blurRegions: blurRegions.length,
      });
      return { type: "split_vertical", topCrops, bottom, topRatio: TOP_RATIO, blurRegions };
    }

    // Mix: la scena sorgente cambia dentro la stessa clip. Base "single" per l'intera durata,
    // split_vertical sovrapposto SOLO nelle finestre effettivamente eligible (vedi
    // Layout.type "mixed" e build-video-filter.ts per come viene composto in render).
    const { crops: singleCrops, backgroundFill } = buildSingleCrops();
    const splitCrops = topCrops.filter((_, i) => splitEligible[i]);
    logger.info("Layout reaction-cam: scena mista rilevata (webcam + single in tratti diversi)", {
      segments: segmentCount,
      splitSegments: splitCrops.length,
      blurRegions: blurRegions.length,
    });
    return { type: "mixed", singleCrops, backgroundFill, splitCrops, bottom, topRatio: TOP_RATIO, blurRegions };
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
  ): Promise<{ webcamCandidates: ClusterMeta[]; singleCrop: CropWindow; singleCropNeedsFill: boolean }> {
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
      return {
        webcamCandidates: [],
        singleCrop: centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, targetAspect),
        singleCropNeedsFill: false,
      };
    }

    const clusters = clusterDetections(samples);
    const minCount = Math.max(1, Math.ceil(framesWithDetection * MIN_STABLE_RATIO));
    const stable = clusters.filter((c) => c.sampleIndices.size >= minCount);

    if (stable.length === 0) {
      return {
        webcamCandidates: [],
        singleCrop: centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, targetAspect),
        singleCropNeedsFill: false,
      };
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
    // Sfondo sfocato solo se il volto è DAVVERO decentrato verticalmente (non ogni volta che è
    // semplicemente grande): un volto vicino al centro verticale non perde quasi nulla restando
    // centrato (maxSymmetricCropHeight ≈ sourceHeight), mentre uno vicino al bordo (webcam
    // grande ma posizionata in basso/alto nel frame) costringerebbe subjectCentricCrop a un
    // crop molto più piccolo del previsto pur di restare centrato — lì conviene mostrarlo più
    // piccolo con lo sfondo dietro piuttosto che un crop striminzito a piena canvas.
    const singleCropNeedsFill = primary ? maxSymmetricCropHeight(primary.avg, sourceHeight) < sourceHeight * BACKGROUND_FILL_TRIGGER_RATIO : false;

    const webcamCandidates = withMeta.filter((m) => isWebcamLike(m.avg, sourceWidth, sourceHeight));

    return { webcamCandidates, singleCrop, singleCropNeedsFill };
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
  ): { decisions: SegmentDecision[]; anchorGroups: PositionGroup[] } {
    const allCandidates: Array<{ segIndex: number; meta: ClusterMeta }> = [];
    rawSegments.forEach((seg, segIndex) => {
      for (const meta of seg.webcamCandidates) {
        allCandidates.push({ segIndex, meta });
      }
    });

    const minAnchorCoverage = segmentCount <= 2 ? 1 : Math.max(2, Math.ceil(segmentCount * MIN_ANCHOR_SEGMENT_COVERAGE_RATIO));
    const anchorGroups = clusterByPosition(allCandidates).filter((g) => g.segIndices.size >= minAnchorCoverage);

    const topAspect = OUTPUT_RESOLUTION.width / (OUTPUT_RESOLUTION.height * TOP_RATIO);

    const decisions = rawSegments.map((seg) => {
      // Per ogni candidato di questo segmento, risali all'ancora (identità) stabile a cui
      // appartiene. Il movimento (per capire chi parla ORA) è un dato per-segmento reale e va
      // preso dal candidato di questo segmento; ma la GEOMETRIA del crop deve usare la media
      // stabile dell'ancora (calcolata su tutti i segmenti in cui quell'identità è comparsa),
      // non il riquadro rumoroso del singolo segmento — altrimenti anche restando sulla stessa
      // persona il crop "salta" leggermente ad ogni segmento per il solo rumore del detector,
      // e una singola rilevazione parziale (es. volto di taglio) produce un crop mal centrato.
      const anchoredHere = seg.webcamCandidates
        .map((m) => ({ meta: m, anchor: anchorGroups.find((g) => isNearBox(m.avg, g.avg)) }))
        .filter((c): c is { meta: ClusterMeta; anchor: PositionGroup } => c.anchor !== undefined);

      const chosenMeta = selectBest(anchoredHere.map((c) => c.meta));
      const chosen = anchoredHere.find((c) => c.meta === chosenMeta);

      return {
        startSeconds: seg.startSeconds,
        endSeconds: seg.endSeconds,
        webcamCrop: chosen ? subjectCentricCrop(chosen.anchor.avg, sourceWidth, sourceHeight, topAspect, WEBCAM_PADDING_FACTOR) : null,
        singleCrop: seg.singleCrop,
        singleCropNeedsFill: seg.singleCropNeedsFill,
      };
    });

    return { decisions, anchorGroups };
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

/**
 * Distingue un miss isolato del detector (ancora comunque valida, verrà riusata dal vicino) da
 * un buco sostenuto che segnala un vero cambio di scena sorgente: un run di `false` più corto
 * di MIN_CONSECUTIVE_MISSES_TO_SWITCH viene "promosso" a true (resta eligible per lo split),
 * un run più lungo resta false (quel tratto passa alla base "single" nel layout "mixed").
 */
function smoothEligibility(genuineMatch: boolean[]): boolean[] {
  const result = [...genuineMatch];
  let i = 0;
  while (i < result.length) {
    if (genuineMatch[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < result.length && !genuineMatch[j]) j++;
    const runLength = j - i;
    if (runLength < MIN_CONSECUTIVE_MISSES_TO_SWITCH) {
      for (let k = i; k < j; k++) result[k] = true;
    }
    i = j;
  }
  return result;
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
  // Richiede spostamento dal centro su ENTRAMBI gli assi (un vero angolo), non uno solo.
  // Verificato su un caso reale: un volto centrato orizzontalmente ma spostato in alto (tipico
  // di un volto "principale" dentro un video reagito, non un overlay in un angolo) passava il
  // filtro con l'OR, e - muovendosi di più essendo un contenuto pre-registrato continuo -
  // batteva quasi sempre la vera webcam del reactor (piccola, in un angolo vero) nel confronto
  // sul movimento. Con l'AND quel volto non qualifica nemmeno come candidato.
  return offCenterX && offCenterY;
}

/**
 * Applica una media mobile esponenziale al centro e all'altezza di una sequenza di crop
 * (un valore per segmento), poi ricostruisce x/y/width/height mantenendo l'aspect ratio
 * target e restando dentro i bound sorgente — usato SOLO per il layout "schermo intero"
 * (una persona zoomata, senza split webcam/contenuto): senza, ogni segmento da 2s calcola
 * il proprio crop in modo indipendente e anche piccole variazioni nel volto rilevato tra un
 * segmento e l'altro producevano uno "scatto" visibile pur restando sulla stessa persona.
 * Non tocca la logica di switch tra chi parla (quella vive in resolveWebcamAnchors).
 */
function smoothCropSequence(crops: CropWindow[], targetAspect: number, sourceWidth: number, sourceHeight: number): CropWindow[] {
  if (crops.length === 0) return crops;

  const rebuild = (cx: number, cy: number, rawHeight: number): CropWindow => {
    let height = Math.min(sourceHeight, rawHeight);
    let width = height * targetAspect;
    if (width > sourceWidth) {
      width = sourceWidth;
      height = width / targetAspect;
    }
    const x = clampNum(Math.round(cx - width / 2), 0, sourceWidth - width);
    const y = clampNum(Math.round(cy - height / 2), 0, sourceHeight - height);
    return { x, y, width: Math.round(width), height: Math.round(height) };
  };

  const diag = Math.hypot(sourceWidth, sourceHeight);

  const first = crops[0]!;
  let smoothedCx = first.x + first.width / 2;
  let smoothedCy = first.y + first.height / 2;
  let smoothedHeight = first.height;
  const result: CropWindow[] = [rebuild(smoothedCx, smoothedCy, smoothedHeight)];

  for (let i = 1; i < crops.length; i++) {
    const cur = crops[i]!;
    const curCx = cur.x + cur.width / 2;
    const curCy = cur.y + cur.height / 2;

    const heightRatio = cur.height / smoothedHeight;
    const centerDist = Math.hypot(curCx - smoothedCx, curCy - smoothedCy);
    const isSceneChange =
      heightRatio > SMOOTHING_CUT_HEIGHT_RATIO || heightRatio < 1 / SMOOTHING_CUT_HEIGHT_RATIO || centerDist > SMOOTHING_CUT_CENTER_RATIO * diag;

    if (isSceneChange) {
      smoothedCx = curCx;
      smoothedCy = curCy;
      smoothedHeight = cur.height;
    } else {
      smoothedCx = SINGLE_CROP_SMOOTHING_ALPHA * curCx + (1 - SINGLE_CROP_SMOOTHING_ALPHA) * smoothedCx;
      smoothedCy = SINGLE_CROP_SMOOTHING_ALPHA * curCy + (1 - SINGLE_CROP_SMOOTHING_ALPHA) * smoothedCy;
      smoothedHeight = SINGLE_CROP_SMOOTHING_ALPHA * cur.height + (1 - SINGLE_CROP_SMOOTHING_ALPHA) * smoothedHeight;
    }
    result.push(rebuild(smoothedCx, smoothedCy, smoothedHeight));
  }

  return result;
}

function clampNum(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
