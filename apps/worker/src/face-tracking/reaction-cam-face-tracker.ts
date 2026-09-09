import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import type { CropWindow, FaceTracker, Layout, TimedCrop } from "./face-tracker.js";
import { extractRawFrameBGR } from "./frame-extractor.js";
import { detectFaces, type FaceBox } from "./onnx-face-detector.js";
import { computeMouthMotion } from "./mouth-motion.js";
import { centeredCrop, subjectCentricCrop } from "./crop-geometry.js";
import { CenterCropFaceTracker } from "./center-crop-face-tracker.js";
import { detectSceneCuts } from "./scene-detect.js";
import { logger } from "../lib/logger.js";

const SEGMENT_LENGTH_SECONDS = 1.5; // granularità con cui si ricontrolla CHI sta parlando. Non influenza più la stabilità dell'inquadratura (il crop di una persona è fisso, vedi sotto), quindi non serve scendere a 1s come prima: 1.5s dimezza i frame da estrarre a parità di reattività percepita
const MAX_SEGMENTS = 40;
const SAMPLES_PER_SEGMENT = 3;
const MOTION_FRAME_DELAY_SECONDS = 0.15; // distanza tra i due frame usati per stimare il movimento della bocca

const MIN_STABLE_RATIO = 0.5; // il cluster deve comparire in almeno metà dei sample (del segmento) con un volto
const WEBCAM_MAX_AREA_RATIO = 0.05; // il volto occupa <5% dell'area del frame
const WEBCAM_CENTER_MARGIN = 0.3; // centro del volto fuori dal 30%-70% centrale (orizz. o vert.)
/**
 * Quanto allargare il crop attorno al volto per ottenere l'inquadratura della webcam. Volutamente
 * generoso: l'obiettivo è mostrare la webcam INTERA (persona, sfondo della stanza, cornice
 * dell'overlay), non un primo piano sul viso. Meglio includere qualche pixel di gioco attorno che
 * tagliare la webcam — un ritaglio troppo stretto è esattamente il "primo piano zoomato" che
 * l'utente ha chiesto di eliminare.
 */
const WEBCAM_PADDING_FACTOR = 4.5;
/**
 * Aspetto del crop webcam: 16:9, l'inquadratura naturale di una webcam, NON l'aspetto del
 * pannello. Il pannello poi la contiene per intero e la centra (vedi build-video-filter.ts):
 * forzare qui l'aspetto del pannello significherebbe ritagliare la webcam per farcela stare.
 */
const WEBCAM_CROP_ASPECT = 16 / 9;
const TOP_RATIO = 0.35; // frazione di altezza dedicata alla webcam nel layout split
const MOTION_NOISE_FLOOR = 4; // sotto questa soglia il "movimento" è rumore/compressione, non parlato reale
const BLUR_REGION_PADDING_FACTOR = 4; // margine generoso: l'overlay webcam reale è quasi sempre più grande del solo riquadro del volto rilevato, meglio sfocare un po' di più che lasciare una fetta visibile
const MIN_SEGMENT_SECONDS = 0.3; // un taglio di scena troppo vicino al confine della griglia (o a un altro taglio) verrebbe scartato invece di creare un segmento degenere: sotto questa durata SAMPLES_PER_SEGMENT frame ravvicinatissimi non danno una stima affidabile
const MIN_CONSECUTIVE_SEGMENTS_TO_SWITCH_SPEAKER = 2; // segmenti di fila in cui un'ANCORA DIVERSA da quella attualmente mostrata deve avere più movimento prima di "rubarle" il pannello — senza, basta un istante in cui un ascoltatore reagisce (ride, annuisce) più vistosamente del narratore per far sparire chi sta davvero parlando. Verificato su un caso reale: un solo narratore per un'intera clip di 22s, ma il pannello continuava a saltare tra 3 co-host diversi segmento per segmento.

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
  /** Chi è mostrato in questo segmento (null = il detector non ha visto nessuna ancora qui). */
  anchor: PositionGroup | null;
}

/** Risultato grezzo di un segmento, prima della selezione dell'ancora cross-segmento. */
interface SegmentDetections {
  startSeconds: number;
  endSeconds: number;
  webcamCandidates: ClusterMeta[]; // tutti i volti "webcam-like" trovati in QUESTO segmento, non ancora filtrati
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

    const gridCount = Math.min(MAX_SEGMENTS, Math.max(1, Math.round(clipDuration / SEGMENT_LENGTH_SECONDS)));
    const gridLength = clipDuration / gridCount;
    const gridBoundaries = Array.from({ length: gridCount + 1 }, (_, i) => i * gridLength);

    // Un editor che monta reaction/gameplay può tagliare da "reactor schermo intero" a
    // "contenuto schermo intero" (e viceversa) in una frazione di secondo — più veloce di
    // qualunque griglia fissa, anche a 1s. Se un taglio del genere cade A METÀ di un segmento
    // della griglia, quel segmento finisce per campionare DUE inquadrature diverse e produce un
    // crop "medio" sbagliato per entrambe (verificato su un caso reale: crop centrato a metà tra
    // il volto del reactor e un elemento del gioco, mal posizionato su entrambi). Allineare i
    // confini dei segmenti ai tagli REALI (rilevati via diff pixel, non ML — economico) risolve
    // il problema alla radice per QUALUNQUE clip con questo stile di montaggio, non solo quella
    // in cui è stato osservato per la prima volta.
    let cutTimes: number[] = [];
    try {
      cutTimes = await detectSceneCuts(sourceVideoPath, startSeconds, clipDuration);
    } catch (err) {
      logger.warn("Rilevamento tagli di scena fallito, uso solo la griglia temporale fissa", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const boundaries = mergeSegmentBoundaries(gridBoundaries, cutTimes, clipDuration);
    const segmentCount = boundaries.length - 1;

    const rawSegments: SegmentDetections[] = [];
    for (let i = 0; i < segmentCount; i++) {
      const segStart = boundaries[i]!;
      const segEnd = boundaries[i + 1]!;
      try {
        const detections = await this.detectSegment(sourceVideoPath, sourceWidth, sourceHeight, startSeconds + segStart, startSeconds + segEnd);
        rawSegments.push({ startSeconds: segStart, endSeconds: segEnd, ...detections });
      } catch (err) {
        logger.warn("Face detection fallita per un segmento, nessun candidato webcam per quel tratto", {
          error: err instanceof Error ? err.message : String(err),
        });
        rawSegments.push({ startSeconds: segStart, endSeconds: segEnd, webcamCandidates: [] });
      }
    }

    const { decisions, anchorGroups } = this.resolveWebcamAnchors(rawSegments, segmentCount);

    // Nessuna webcam riconoscibile (gameplay puro, contenuto solo visivo, o volti presenti ma
    // tutti dentro il contenuto reagito): un unico crop centrato statico. Niente primo piano
    // inseguito sul volto — vedi il commento sul tipo Layout in face-tracker.ts.
    if (!decisions.some((d) => d.anchor !== null)) {
      logger.info("Nessun pattern webcam sostenuto: layout statico a schermo intero", { segments: segmentCount });
      return this.fallback.computeLayout(params);
    }

    // Un ritaglio per PERSONA, calcolato una volta sola dalla posizione media del suo volto: per
    // tutti i segmenti in cui parla quella persona il ritaglio è identico al pixel, quindi
    // l'inquadratura non si muove mai finché non cambia chi parla.
    const cropByAnchor = new Map<PositionGroup, CropWindow>(
      anchorGroups.map((anchor) => [
        anchor,
        subjectCentricCrop(anchor.avg, sourceWidth, sourceHeight, WEBCAM_CROP_ASPECT, WEBCAM_PADDING_FACTOR),
      ]),
    );

    const bottomAspect = OUTPUT_RESOLUTION.width / (OUTPUT_RESOLUTION.height * (1 - TOP_RATIO));
    const bottom = centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, bottomAspect);
    // Ogni ancora valida è, per definizione, un overlay webcam fisso nel frame sorgente — e
    // il pannello "contenuto" sotto è un crop dell'INTERO frame sorgente, quindi la mostra
    // di nuovo, piccola (e spesso tagliata dal bordo del crop). Sfochiamo quelle zone nel
    // rendering invece di lasciarle visibili due volte.
    const blurRegions: CropWindow[] = anchorGroups.map((g) => subjectCentricCrop(g.avg, sourceWidth, sourceHeight, 1, BLUR_REGION_PADDING_FACTOR));

    // Segmenti in cui il detector non ha visto l'ancora (volto girato, mano davanti alla bocca):
    // riusano la posizione valida più vicina, così la webcam non "sparisce" per un tratto in cui
    // il rilevamento è fallito per caso. Il crop di una stessa persona è sempre identico, quindi
    // segmenti consecutivi sullo stesso speaker collassano in un unico blocco immobile.
    const topCrops: TimedCrop[] = decisions.map((d, i) => ({
      startSeconds: d.startSeconds,
      endSeconds: d.endSeconds,
      crop: cropByAnchor.get(d.anchor ?? nearestAnchor(decisions, i))!,
    }));

    logger.info("Layout split rilevato (webcam sopra, contenuto fisso sotto)", {
      segments: segmentCount,
      withWebcam: decisions.filter((d) => d.anchor).length,
      speakers: anchorGroups.length,
      blurRegions: blurRegions.length,
    });
    return { type: "split_vertical", topCrops, bottom, topRatio: TOP_RATIO, blurRegions };
  }

  /**
   * Rileva i volti in un singolo segmento temporale e ne ritorna i candidati "webcam-like" (non
   * ancora ridotti a uno solo: la scelta finale considera anche gli altri segmenti, vedi
   * resolveWebcamAnchors).
   */
  private async detectSegment(
    videoPath: string,
    sourceWidth: number,
    sourceHeight: number,
    absStart: number,
    absEnd: number,
  ): Promise<{ webcamCandidates: ClusterMeta[] }> {
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

    const framesWithDetection = samples.filter((s) => s.length > 0).length;
    if (framesWithDetection === 0) return { webcamCandidates: [] };

    const clusters = clusterDetections(samples);
    const minCount = Math.max(1, Math.ceil(framesWithDetection * MIN_STABLE_RATIO));
    const stable = clusters.filter((c) => c.sampleIndices.size >= minCount);
    if (stable.length === 0) return { webcamCandidates: [] };

    const withMeta: ClusterMeta[] = stable.map((c) => ({
      avg: averageBox(c.entries.map((e) => e.box)),
      count: c.sampleIndices.size,
      motion: c.entries.reduce((sum, e) => sum + e.motion, 0) / c.entries.length,
    }));

    return { webcamCandidates: withMeta.filter((m) => isWebcamLike(m.avg, sourceWidth, sourceHeight)) };
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
  ): { decisions: SegmentDecision[]; anchorGroups: PositionGroup[] } {
    const allCandidates: Array<{ segIndex: number; meta: ClusterMeta }> = [];
    rawSegments.forEach((seg, segIndex) => {
      for (const meta of seg.webcamCandidates) {
        allCandidates.push({ segIndex, meta });
      }
    });

    const minAnchorCoverage = segmentCount <= 2 ? 1 : Math.max(2, Math.ceil(segmentCount * MIN_ANCHOR_SEGMENT_COVERAGE_RATIO));
    // maxMotion > MOTION_NOISE_FLOOR: un'ancora valida deve aver mostrato un minimo di movimento
    // reale della bocca in ALMENO una delle sue occorrenze — verificato su un caso reale dove
    // un'immagine statica (una foto mostrata come contenuto) ricompariva nella stessa posizione
    // in più segmenti (proprio perché non cambia mai) e passava il solo filtro di persistenza,
    // rubando il posto al vero reactor in un segmento su sei.
    const anchorGroups = clusterByPosition(allCandidates).filter(
      (g) => g.segIndices.size >= minAnchorCoverage && g.maxMotion > MOTION_NOISE_FLOOR,
    );

    // Stato "sticky" dello speaker attualmente mostrato: portato avanti da un segmento al
    // successivo (vedi MIN_CONSECUTIVE_SEGMENTS_TO_SWITCH_SPEAKER) — per questo il ciclo è un
    // map con closure mutabile, non stateless come il resto del file.
    let currentAnchor: PositionGroup | undefined;
    let challengerAnchor: PositionGroup | undefined;
    let challengerStreak = 0;

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

      let chosen: { meta: ClusterMeta; anchor: PositionGroup } | undefined;
      const currentHere = currentAnchor ? anchoredHere.find((c) => c.anchor === currentAnchor) : undefined;

      if (currentHere) {
        // Lo speaker già in scena è presente anche qui: gli resta il pannello a meno che
        // un'ancora diversa non lo superi in movimento per MIN_CONSECUTIVE_SEGMENTS_TO_SWITCH_SPEAKER
        // segmenti DI FILA (non basta un singolo secondo più vivace di un ascoltatore).
        const others = anchoredHere.filter((c) => c.anchor !== currentAnchor);
        const bestOtherMeta = others.length > 0 ? selectBest(others.map((c) => c.meta)) : undefined;
        const bestOther = bestOtherMeta ? others.find((c) => c.meta === bestOtherMeta) : undefined;

        if (bestOther && bestOther.meta.motion > currentHere.meta.motion) {
          challengerStreak = challengerAnchor === bestOther.anchor ? challengerStreak + 1 : 1;
          challengerAnchor = bestOther.anchor;
          if (challengerStreak >= MIN_CONSECUTIVE_SEGMENTS_TO_SWITCH_SPEAKER) {
            chosen = bestOther;
            currentAnchor = bestOther.anchor;
            challengerAnchor = undefined;
            challengerStreak = 0;
          } else {
            chosen = currentHere;
          }
        } else {
          chosen = currentHere;
          challengerAnchor = undefined;
          challengerStreak = 0;
        }
      } else {
        // Lo speaker in scena non è presente qui (o non ne abbiamo ancora scelto uno): sceglie
        // normalmente tra i candidati di questo segmento e lo adotta come nuovo "corrente".
        const chosenMeta = selectBest(anchoredHere.map((c) => c.meta));
        chosen = anchoredHere.find((c) => c.meta === chosenMeta);
        currentAnchor = chosen?.anchor ?? currentAnchor;
        challengerAnchor = undefined;
        challengerStreak = 0;
      }

      // Si restituisce l'IDENTITÀ mostrata, non un ritaglio: il ritaglio è uno solo per persona
      // (calcolato dal chiamante) e resta quindi identico al pixel per tutti i segmenti in cui
      // parla la stessa persona — l'inquadratura non si muove finché non cambia chi parla. Il
      // movimento del singolo segmento serve solo a decidere CHI mostrare, non DOVE inquadrare.
      return { startSeconds: seg.startSeconds, endSeconds: seg.endSeconds, anchor: chosen?.anchor ?? null };
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
 * Unisce la griglia temporale fissa (`grid`, punti equidistanti) con i tagli di scena reali
 * rilevati (`cuts`, clip-relativi): il risultato sono i confini dei segmenti da usare per la
 * face detection, MAI più fitti di MIN_SEGMENT_SECONDS (un taglio troppo vicino a un confine
 * già presente viene scartato invece di creare un segmento degenere). `grid` e `clipDuration`
 * garantiscono che il primo/ultimo confine siano sempre 0 e clipDuration.
 */
function mergeSegmentBoundaries(grid: number[], cuts: number[], clipDuration: number): number[] {
  const candidates = [...grid, ...cuts.filter((c) => c > 0 && c < clipDuration)].sort((a, b) => a - b);

  const merged: number[] = [0];
  for (const t of candidates) {
    const last = merged[merged.length - 1]!;
    if (t - last >= MIN_SEGMENT_SECONDS) merged.push(t);
  }

  const last = merged[merged.length - 1]!;
  if (clipDuration - last >= MIN_SEGMENT_SECONDS) {
    merged.push(clipDuration);
  } else {
    merged[merged.length - 1] = clipDuration;
  }
  return merged;
}

/** Trova l'ancora del segmento valido più vicino (prima prova indietro, poi avanti). */
function nearestAnchor(decisions: SegmentDecision[], fromIndex: number): PositionGroup {
  for (let offset = 1; offset < decisions.length; offset++) {
    const before = decisions[fromIndex - offset];
    if (before?.anchor) return before.anchor;
    const after = decisions[fromIndex + offset];
    if (after?.anchor) return after.anchor;
  }
  // Irraggiungibile: il chiamante usa questa funzione solo dopo aver verificato che almeno un
  // segmento ha un'ancora (altrimenti l'intera clip va sul layout statico).
  throw new Error("nearestAnchor: nessuna ancora disponibile");
}

interface PositionGroup {
  avg: FaceBox;
  segIndices: Set<number>;
  entries: FaceBox[];
  /**
   * Massimo movimento della bocca registrato in QUALUNQUE occorrenza di questo gruppo — serve a
   * scartare un'ancora che ricompare nella stessa posizione ma non è mai stata associata a un
   * minimo di movimento reale (vedi filtro in resolveWebcamAnchors). Un'immagine statica
   * mostrata come contenuto (es. una foto/meme) può ricomparire nella stessa posizione per più
   * segmenti proprio perché non cambia mai — passando altrimenti il filtro di persistenza
   * pensato per riconoscere un overlay webcam reale.
   */
  maxMotion: number;
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
      bestGroup.maxMotion = Math.max(bestGroup.maxMotion, meta.motion);
    } else {
      groups.push({ avg: meta.avg, segIndices: new Set([segIndex]), entries: [meta.avg], maxMotion: meta.motion });
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
