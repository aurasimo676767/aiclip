import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import type { CropWindow, FaceTracker, Layout, Scene, SceneComposition, TimedCrop } from "./face-tracker.js";
import { extractRawFrameBGR, extractRawFrameBGRScaled } from "./frame-extractor.js";
import { detectFaces, type FaceBox } from "./onnx-face-detector.js";
import { computeMouthMotion } from "./mouth-motion.js";
import { centeredCrop } from "./crop-geometry.js";
import { CenterCropFaceTracker } from "./center-crop-face-tracker.js";
import { detectSceneCuts } from "./scene-detect.js";
import { detectWebcamRect } from "./webcam-rect.js";
import { detectContentBounds, detectContentRegion } from "./content-region.js";
import { logger } from "../lib/logger.js";

const SEGMENT_LENGTH_SECONDS = 1.5; // granularità con cui si ricontrolla CHI sta parlando. Non influenza più la stabilità dell'inquadratura (il crop di una persona è fisso, vedi sotto), quindi non serve scendere a 1s come prima: 1.5s dimezza i frame da estrarre a parità di reattività percepita
const MAX_SEGMENTS = 40;
const SAMPLES_PER_SEGMENT = 3;
const MOTION_FRAME_DELAY_SECONDS = 0.15; // distanza tra i due frame usati per stimare il movimento della bocca
/** Larghezza dei fotogrammi usati per misurare il movimento della bocca: vedi mouth-motion.ts. */
const MOTION_FRAME_WIDTH = 960;

const MIN_STABLE_RATIO = 0.5; // il cluster deve comparire in almeno metà dei sample (del segmento) con un volto
const WEBCAM_MAX_AREA_RATIO = 0.05; // il volto occupa <5% dell'area del frame
const WEBCAM_CENTER_MARGIN = 0.3; // centro del volto fuori dal 30%-70% centrale (orizz. o vert.)
/**
 * Frazione di altezza dedicata alla webcam. Non è fissa: viene calcolata dalle PROPORZIONI del
 * riquadro webcam rilevato, così la webcam riempie il pannello senza bande nere e senza essere
 * tagliata. Con un pannello di forma fissa, una webcam con proporzioni diverse lasciava bande
 * spesse sopra e sotto — brutte da vedere in uno Short. I limiti servono a non prendersi mezzo
 * schermo (webcam molto quadrate) né una striscia inguardabile (webcam molto larghe).
 */
const MIN_TOP_RATIO = 0.22;
const MAX_TOP_RATIO = 0.5;

function topRatioForWebcam(rects: CropWindow[]): number {
  // Si usa l'aspetto PIÙ STRETTO (la webcam più "alta") fra quelle rilevate, non la mediana: il
  // pannello viene riempito in "cover", che ritaglia sull'asse in eccesso. Con un pannello più
  // basso della webcam il ritaglio cade in VERTICALE e taglia la testa — verificato su una clip
  // vera, la fronte dello streamer era mozzata. Prendendo l'aspetto minimo ogni webcam è larga
  // almeno quanto il pannello, quindi il ritaglio cade sempre in orizzontale e mangia solo un po'
  // di sfondo ai lati.
  const aspects = rects.map((r) => r.width / r.height).filter((a) => Number.isFinite(a) && a > 0);
  const narrowest = Math.min(...aspects);
  if (!aspects.length || !Number.isFinite(narrowest)) return 0.35;
  const paneHeight = OUTPUT_RESOLUTION.width / narrowest;
  return Math.min(MAX_TOP_RATIO, Math.max(MIN_TOP_RATIO, paneHeight / OUTPUT_RESOLUTION.height));
}
const MOTION_NOISE_FLOOR = 4; // sotto questa soglia il "movimento" è rumore/compressione, non parlato reale
/** Fotogrammi campionati per trovare il riquadro della webcam: è la loro media a far emergere i bordi fermi. */
const RECT_SAMPLE_COUNT = 14;
const MIN_SEGMENT_SECONDS = 0.3; // un taglio di scena troppo vicino al confine della griglia (o a un altro taglio) verrebbe scartato invece di creare un segmento degenere: sotto questa durata SAMPLES_PER_SEGMENT frame ravvicinatissimi non danno una stima affidabile
const MIN_CONSECUTIVE_SEGMENTS_TO_SWITCH_SPEAKER = 2; // segmenti di fila in cui un'ANCORA DIVERSA da quella attualmente mostrata deve avere più movimento prima di "rubarle" il pannello — senza, basta un istante in cui un ascoltatore reagisce (ride, annuisce) più vistosamente del narratore per far sparire chi sta davvero parlando. Verificato su un caso reale: un solo narratore per un'intera clip di 22s, ma il pannello continuava a saltare tra 3 co-host diversi segmento per segmento.

/** Altezza corrispondente a MOTION_FRAME_WIDTH, pari (ffmpeg rifiuta dimensioni dispari con alcuni formati). */
function motionFrameHeight(sourceWidth: number, sourceHeight: number): number {
  return Math.round((sourceHeight * (MOTION_FRAME_WIDTH / sourceWidth)) / 2) * 2;
}

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
  /** TUTTI i volti stabili del segmento, anche quelli non webcam-like: servono a inquadrare
   * ogni scena quando non c'e' nessuna webcam (vedi perSceneCompositions). */
  allFaces: ClusterMeta[];
}

/**
 * Proporzioni ammesse per un overlay webcam. Una webcam riprende con un sensore orizzontale: i
 * formati reali stanno fra il 4:3 (1.33) e il 16:9 (1.78), e un ritaglio dell'inquadratura non si
 * allontana molto da lì. Il player del video reagito e i ritagli fatti al suo interno invece hanno
 * forme qualsiasi.
 *
 * Misurato su 8 webcam vere di 4 stream diversi: da 1.05 a 1.48. Sui riquadri falsi che arrivano
 * fino a questo controllo negli stessi video: 0.67, 0.86, 1.18, 2.32, 2.70. La finestra scarta
 * tutto ciò che è più alto che largo o largo il doppio dell'altezza, lasciando spazio al 16:9.
 */
const MIN_WEBCAM_ASPECT = 0.9;
const MAX_WEBCAM_ASPECT = 1.85;

/**
 * Un overlay webcam lascia vedere il gioco/il video reagito: è quello il suo scopo, quindi non può
 * prendersi lo schermo. Non è però necessariamente piccolo — su uno degli stream di prova la webcam
 * vera di Blur occupa il 21% dello schermo, quindi una soglia stretta la scarterebbe. Il falso con
 * proporzioni da webcam che va fermato qui (il player del video reagito, quasi a tutto schermo) sta
 * al 44.9%: la soglia sta larga in mezzo ai due.
 */
const MAX_WEBCAM_AREA_RATIO = 0.3;

/**
 * Un overlay webcam è ancorato a un bordo dello schermo (angolo o lato): è così che si compone una
 * scena da streaming, per non coprire il centro. Sulle stesse 8 webcam vere ognuna toccava almeno un
 * bordo (scarto massimo 2px), mentre un volto dentro un TikTok a metà schermo — che ha proporzioni e
 * dimensioni del tutto plausibili, quindi passa gli altri due controlli — distava 136px dal bordo
 * più vicino. La tolleranza è generosa (4% del lato) per non escludere layout che lasciano un
 * margine attorno alla cam.
 */
const WEBCAM_EDGE_TOLERANCE_RATIO = 0.04;

/**
 * Perché questo riquadro NON può essere una webcam, o null se è plausibile. I tre controlli sono
 * indipendenti e ognuno da solo lascerebbe passare qualche falso: vedi le costanti qui sopra per i
 * valori misurati che fissano ciascuna soglia.
 */
function rejectionReasonForWebcamRect(rect: CropWindow, sourceWidth: number, sourceHeight: number): string | null {
  const aspect = rect.width / rect.height;
  if (!Number.isFinite(aspect) || aspect < MIN_WEBCAM_ASPECT || aspect > MAX_WEBCAM_ASPECT) {
    return `proporzioni non da webcam (${aspect.toFixed(2)})`;
  }
  const areaRatio = (rect.width * rect.height) / (sourceWidth * sourceHeight);
  if (areaRatio > MAX_WEBCAM_AREA_RATIO) {
    return `troppo grande per essere un inserto (${(areaRatio * 100).toFixed(1)}% dello schermo)`;
  }
  const tolX = sourceWidth * WEBCAM_EDGE_TOLERANCE_RATIO;
  const tolY = sourceHeight * WEBCAM_EDGE_TOLERANCE_RATIO;
  const touchesEdge =
    rect.x <= tolX || rect.y <= tolY || rect.x + rect.width >= sourceWidth - tolX || rect.y + rect.height >= sourceHeight - tolY;
  if (!touchesEdge) return "non tocca nessun bordo dello schermo, sta in mezzo al contenuto";
  return null;
}

const MIN_ANCHOR_SEGMENT_COVERAGE_RATIO = 0.4; // un volto deve ricomparire in almeno questa frazione dei segmenti per essere considerato "la webcam reale" e non un volto di passaggio nel contenuto reagito

/**
 * Un volto alto almeno questa frazione del frame è il SOGGETTO di quell'inquadratura (streamer a
 * schermo intero), non una faccia dentro il contenuto. Misurato su un VOD già montato: nelle
 * inquadrature a schermo intero il volto era alto il 43-69% del frame, mentre nelle inquadrature
 * con condivisione schermo la cam nell'angolo stava al 10-15%. La soglia sta comoda in mezzo.
 */
const SCENE_SUBJECT_MIN_HEIGHT_RATIO = 0.25;

/** Fotogrammi campionati DENTRO una scena per cercarci la cam e il contenuto. Poche: le scene sono corte. */
const SCENE_SAMPLE_COUNT = 6;

/**
 * Sceglie la composizione di OGNI SCENA del montaggio originale.
 *
 * Perche' per scena e non una sola per clip: molti VOD non sono stream grezzi ma video GIA'
 * MONTATI, che staccano ogni pochi secondi fra streamer a schermo intero, gameplay a schermo
 * intero e condivisione schermo con la cam in un angolo. Una composizione sola non puo' andare
 * bene per tutte e tre — su una clip reale ne usciva il gioco ingrandito e tagliato per l'intera
 * durata, con lo streamer mai inquadrato.
 *
 * Perche' FISSA dentro la scena e non un inseguimento continuo del volto: misurato su quella
 * clip, dentro un'inquadratura il volto si sposta di 1-38 px, fra un'inquadratura e l'altra di
 * 700-1500 px. Un inseguimento morbido non avrebbe niente da seguire dove la persona sta ferma, e
 * scivolerebbe per mezzo schermo proprio sugli stacchi — dove invece si taglia netto. I confini
 * qui sono gli stacchi VERI del montaggio (vedi scene-detect.ts), quindi il cambio cade dove lo
 * spettatore gia' se lo aspetta.
 */
async function perSceneCompositions(
  sourceVideoPath: string,
  clipStartSeconds: number,
  segments: SegmentDetections[],
  cutTimes: number[],
  clipDuration: number,
  sourceWidth: number,
  sourceHeight: number,
): Promise<Scene[]> {
  const fullAspect = OUTPUT_RESOLUTION.width / OUTPUT_RESOLUTION.height;
  const boundaries = [0, ...cutTimes.filter((t) => t > 0.01 && t < clipDuration - 0.01), clipDuration];

  interface RawScene {
    startSeconds: number;
    endSeconds: number;
    subject: FaceBox | null;
    isSubjectShot: boolean;
    cam: CropWindow | null;
  }

  const raw: RawScene[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const startSeconds = boundaries[i]!;
    const endSeconds = boundaries[i + 1]!;

    // Il volto PIU' GRANDE visto nei segmenti che cadono in questa scena, non la media: dentro una
    // scena il soggetto e' sempre lo stesso, e mediare con qualche rilevamento spurio piu' piccolo
    // sposterebbe l'inquadratura senza motivo.
    let subject: FaceBox | null = null;
    for (const seg of segments) {
      if (seg.endSeconds <= startSeconds + 0.01 || seg.startSeconds >= endSeconds - 0.01) continue;
      for (const meta of seg.allFaces) {
        if (!subject || meta.avg.height > subject.height) subject = meta.avg;
      }
    }
    const isSubjectShot = subject !== null && subject.height >= sourceHeight * SCENE_SUBJECT_MIN_HEIGHT_RATIO;

    let cam: CropWindow | null = null;
    if (subject && !isSubjectShot) {
      const duration = Math.max(0.1, endSeconds - startSeconds);
      const sampleTimes = Array.from(
        { length: SCENE_SAMPLE_COUNT },
        (_, k) => clipStartSeconds + startSeconds + (duration * (k + 0.5)) / SCENE_SAMPLE_COUNT,
      );
      const found = await detectWebcamRect(sourceVideoPath, sampleTimes, subject, sourceWidth, sourceHeight);
      if (found && !rejectionReasonForWebcamRect(found, sourceWidth, sourceHeight)) cam = found;
    }
    raw.push({ startSeconds, endSeconds, subject, isSubjectShot, cam });
  }

  // UN SOLO riquadro cam per tutta la clip, non uno per scena. Le scene con la cam sono lo stesso
  // momento di stream ripreso piu' volte, quindi la cam sta sempre nello stesso punto: rilevarla
  // scena per scena dava riquadri leggermente diversi (526x296 contro 548x310), che facevano
  // "respirare" il pannello a ogni stacco, e su una scena il rilevamento falliva del tutto
  // lasciandola senza template. Si prende quindi il riquadro piu' ricorrente e si riusa ovunque.
  const canonicalCam = mostRecurrentRect(raw.map((r) => r.cam).filter((c): c is CropWindow => c !== null));

  let topRatio = 0;
  let content: CropWindow | null = null;
  if (canonicalCam) {
    topRatio = topRatioForWebcam([canonicalCam]);
    const bottomAspect = OUTPUT_RESOLUTION.width / (OUTPUT_RESOLUTION.height * (1 - topRatio));
    const clipSamples = Array.from(
      { length: RECT_SAMPLE_COUNT },
      (_, k) => clipStartSeconds + (clipDuration * (k + 0.5)) / RECT_SAMPLE_COUNT,
    );
    // NOTA: qui si usa detectContentRegion (finestra con le proporzioni del pannello) e NON
    // detectContentBounds come nel layout a clip intera. I bordi del contenuto vengono calcolati una
    // volta sola per tutta la clip, ma in un video montato ogni scena inquadra una cosa diversa:
    // provato, ne usciva una fascia 1920x540 buona per nessuna scena e il pannello restava quasi
    // nero. La finestra con le proporzioni del pannello e' invece un compromesso che regge su tutte.
    const region = await detectContentRegion(sourceVideoPath, clipSamples, sourceWidth, sourceHeight, bottomAspect, [canonicalCam]);
    content = region ?? centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, bottomAspect);
  }

  const scenes: Scene[] = raw.map((r) => {
    // 1) Soggetto a schermo intero: ritaglio 9:16 centrato su di lui, riempie lo schermo.
    if (r.isSubjectShot && r.subject) {
      const crop = centeredCrop(r.subject.x + r.subject.width / 2, sourceHeight / 2, sourceWidth, sourceHeight, fullAspect);
      return { startSeconds: r.startSeconds, endSeconds: r.endSeconds, composition: { kind: "crop", crop } };
    }
    // 2) La cam della clip e' visibile anche in questa scena: il template, cam sopra e contenuto
    //    sotto. Basta che ci sia un volto dentro il riquadro noto — non serve che il rilevamento
    //    del riquadro riesca di nuovo proprio qui.
    if (canonicalCam && content && r.subject && faceCenterInside(r.subject, canonicalCam)) {
      return {
        startSeconds: r.startSeconds,
        endSeconds: r.endSeconds,
        composition: { kind: "split", cam: canonicalCam, content, topRatio },
      };
    }
    // 3) Niente cam e niente soggetto: gameplay/schermo a tutto campo. Si mostra INTERO su sfondo
    //    sfocato invece di ritagliarlo — cosa serva vedere dipende dal gioco, e un ritaglio
    //    "sull'azione" tirerebbe a indovinare (scelta esplicita dell'utente).
    return { startSeconds: r.startSeconds, endSeconds: r.endSeconds, composition: { kind: "fit" } };
  });

  return mergeAdjacentScenes(scenes, sourceWidth);
}

function faceCenterInside(face: FaceBox, rect: CropWindow): boolean {
  const cx = face.x + face.width / 2;
  const cy = face.y + face.height / 2;
  return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height;
}

/** Quanto due riquadri possono differire (px) e contare comunque come lo stesso overlay. */
const SAME_RECT_TOLERANCE_PX = 40;

/** Il riquadro che ricorre di piu' fra quelli trovati; a parita', il piu' grande. */
function mostRecurrentRect(rects: CropWindow[]): CropWindow | null {
  if (!rects.length) return null;
  let best: { rect: CropWindow; votes: number } | null = null;
  for (const candidate of rects) {
    const votes = rects.filter(
      (other) => Math.abs(other.x - candidate.x) <= SAME_RECT_TOLERANCE_PX && Math.abs(other.y - candidate.y) <= SAME_RECT_TOLERANCE_PX,
    ).length;
    const better =
      !best || votes > best.votes || (votes === best.votes && candidate.width * candidate.height > best.rect.width * best.rect.height);
    if (better) best = { rect: candidate, votes };
  }
  return best?.rect ?? null;
}

/** Sotto questo spostamento (frazione della larghezza) due ritagli di fila contano come uguali. */
const SCENE_CROP_DEAD_ZONE_RATIO = 0.03;

/**
 * Fonde scene consecutive composte allo stesso modo. Serve a due cose: non trasformare uno
 * spostamento impercettibile in uno stacco visibile, e non gonfiare il filtergraph con decine di
 * pezzi identici da concatenare.
 */
function mergeAdjacentScenes(scenes: Scene[], sourceWidth: number): Scene[] {
  const deadZone = sourceWidth * SCENE_CROP_DEAD_ZONE_RATIO;
  const merged: Scene[] = [];
  for (const scene of scenes) {
    const last = merged[merged.length - 1];
    if (last && sameComposition(last.composition, scene.composition, deadZone)) {
      last.endSeconds = scene.endSeconds;
      continue;
    }
    merged.push({ ...scene });
  }
  return merged;
}

function sameComposition(a: SceneComposition, b: SceneComposition, deadZone: number): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "fit") return true;
  if (a.kind === "crop" && b.kind === "crop") return Math.abs(a.crop.x - b.crop.x) <= deadZone;
  if (a.kind === "split" && b.kind === "split") {
    return Math.abs(a.cam.x - b.cam.x) <= deadZone && Math.abs(a.cam.y - b.cam.y) <= deadZone && a.topRatio === b.topRatio;
  }
  return false;
}

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
        rawSegments.push({ startSeconds: segStart, endSeconds: segEnd, webcamCandidates: [], allFaces: [] });
      }
    }

    const { decisions: rawDecisions, anchorGroups: candidateAnchors } = this.resolveWebcamAnchors(rawSegments, segmentCount);

    // Il riquadro dell'overlay viene cercato nell'immagine (vedi webcam-rect.ts) e serve a DUE
    // cose: dà l'inquadratura esatta da mostrare, e conferma che quel volto sia davvero una
    // webcam. Se attorno al volto non c'è un riquadro da webcam, quel volto è contenuto reagito
    // (tipicamente una faccia dentro un TikTok, che vive dentro il rettangolo del player) e non
    // deve finire nel pannello webcam.
    const sampleTimes = Array.from({ length: RECT_SAMPLE_COUNT }, (_, i) => startSeconds + (clipDuration * (i + 0.5)) / RECT_SAMPLE_COUNT);
    const cropByAnchor = new Map<PositionGroup, CropWindow>();
    for (const anchor of candidateAnchors) {
      const rect = await detectWebcamRect(sourceVideoPath, sampleTimes, anchor.avg, sourceWidth, sourceHeight);
      if (rect) cropByAnchor.set(anchor, rect);
      else logger.info("Volto scartato: non ha attorno un riquadro da webcam (probabile contenuto reagito)", { face: anchor.avg });
    }

    // Un riquadro può passare i controlli di webcam-rect.ts (bordi netti e fermi) pur essendo il
    // PLAYER del video reagito, o un ritaglio arbitrario dentro di esso: anche quello è un
    // rettangolo immobile con bordi marcati. Due proprietà di FORMA e POSIZIONE lo distinguono da
    // un vero overlay webcam, e vanno valutate sul riquadro finale scelto, non sulle alternative.
    for (const anchor of candidateAnchors) {
      const rect = cropByAnchor.get(anchor);
      if (!rect) continue;
      const reason = rejectionReasonForWebcamRect(rect, sourceWidth, sourceHeight);
      if (reason) {
        cropByAnchor.delete(anchor);
        logger.info("Volto scartato: il riquadro attorno non ha la forma di una webcam", { face: anchor.avg, rect, motivo: reason });
      }
    }

    const anchorGroups = candidateAnchors.filter((a) => cropByAnchor.has(a));
    const decisions = rawDecisions.map((d) => ({ ...d, anchor: d.anchor && cropByAnchor.has(d.anchor) ? d.anchor : null }));

    // Nessuna webcam riconoscibile: non c'è niente da affiancare, quindi un crop 9:16 a piena
    // altezza — ma inquadrato SCENA PER SCENA, non uno solo per tutta la clip (vedi perSceneCrops).
    if (!decisions.some((d) => d.anchor !== null)) {
      const scenes = await perSceneCompositions(sourceVideoPath, startSeconds, rawSegments, cutTimes, clipDuration, sourceWidth, sourceHeight);
      if (scenes.length) {
        logger.info("Nessuna webcam fissa per l'intera clip: composizione scelta scena per scena", {
          scene: scenes.map((s) => `${s.startSeconds.toFixed(1)}-${s.endSeconds.toFixed(1)} ${s.composition.kind}`),
        });
        return { type: "scenes", scenes };
      }
      logger.info("Nessuna scena individuata: crop centrato statico", { segments: segmentCount });
      return this.fallback.computeLayout(params);
    }


    const topRatio = topRatioForWebcam([...cropByAnchor.values()]);
    const bottomAspect = OUTPUT_RESOLUTION.width / (OUTPUT_RESOLUTION.height * (1 - topRatio));
    // Inquadratura del contenuto: dove sta davvero succedendo qualcosa, non il centro geometrico
    // del frame. Si prendono i BORDI VERI del contenuto (detectContentBounds), senza vincolo di
    // proporzione, e il render lo mostra intero dentro il pannello. Prima si cercava una finestra
    // con le proporzioni del pannello (detectContentRegion): su un pannello quasi quadrato quel
    // vincolo obbligava la finestra a essere larga mezzo schermo anche quando il contenuto era una
    // colonna stretta — verificato su una reaction a Instagram dentro un browser, dove il pannello
    // mostrava il video a sinistra e per il resto commenti e cornice del browser.
    // Le webcam sono escluse dal conteggio: si muovono anche loro, ma non sono il contenuto.
    const contentBounds = await detectContentBounds(sourceVideoPath, sampleTimes, sourceWidth, sourceHeight, [
      ...cropByAnchor.values(),
    ]);
    const bottom = contentBounds ?? centeredCrop(sourceWidth / 2, sourceHeight / 2, sourceWidth, sourceHeight, bottomAspect);
    // Ogni ancora valida è, per definizione, un overlay webcam fisso nel frame sorgente — e
    // il pannello "contenuto" sotto è un crop dell'INTERO frame sorgente, quindi la mostra
    // di nuovo, piccola (e spesso tagliata dal bordo del crop). Sfochiamo quelle zone nel
    // rendering invece di lasciarle visibili due volte.
    // Si sfoca il riquadro ESATTO della webcam (quello rilevato sopra), non più un rettangolo
    // stimato attorno al volto con un margine generoso: quello a volte lasciava scoperto un bordo
    // della webcam e altre volte sfocava del contenuto attorno che andava lasciato visibile.
    const blurRegions: CropWindow[] = anchorGroups.map((a) => cropByAnchor.get(a)!);

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
    return { type: "split_vertical", topCrops, bottom, topRatio, blurRegions };
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
  ): Promise<{ webcamCandidates: ClusterMeta[]; allFaces: ClusterMeta[] }> {
    const duration = Math.max(0.1, absEnd - absStart);
    const timestamps: number[] = [];
    for (let i = 1; i <= SAMPLES_PER_SEGMENT; i++) {
      timestamps.push(absStart + (duration * i) / (SAMPLES_PER_SEGMENT + 1));
    }

    // Rilevamento volti: basta la risoluzione del modello. Il MOVIMENTO della bocca invece si
    // misura su una coppia di fotogrammi molto più grandi, estratta una sola volta per segmento:
    // a 320x240 la bocca di una webcam piccola è larga pochi pixel e il valore è rumore (vedi
    // mouth-motion.ts). Costa anche meno di prima, che estraeva una coppia per OGNI campione.
    const motionAt = absStart + duration / 2;
    let motionPair: { a: Buffer; b: Buffer } | null = null;
    try {
      const a = await extractRawFrameBGRScaled(videoPath, motionAt, MOTION_FRAME_WIDTH, motionFrameHeight(sourceWidth, sourceHeight));
      const b = await extractRawFrameBGRScaled(
        videoPath,
        motionAt + MOTION_FRAME_DELAY_SECONDS,
        MOTION_FRAME_WIDTH,
        motionFrameHeight(sourceWidth, sourceHeight),
      );
      motionPair = { a, b };
    } catch {
      motionPair = null; // senza movimento i volti restano validi, si sceglie per stabilità/dimensione
    }

    const samples: DetectionEntry[][] = [];
    for (const t of timestamps) {
      const frame = await extractRawFrameBGR(videoPath, t);
      const boxes = await detectFaces(frame, sourceWidth, sourceHeight);
      samples.push(
        boxes.map((box) => ({
          box,
          motion: motionPair
            ? computeMouthMotion(
                motionPair.a,
                motionPair.b,
                box,
                sourceWidth,
                sourceHeight,
                MOTION_FRAME_WIDTH,
                motionFrameHeight(sourceWidth, sourceHeight),
              )
            : 0,
        })),
      );
    }

    const framesWithDetection = samples.filter((s) => s.length > 0).length;
    if (framesWithDetection === 0) return { webcamCandidates: [], allFaces: [] };

    const clusters = clusterDetections(samples);
    const minCount = Math.max(1, Math.ceil(framesWithDetection * MIN_STABLE_RATIO));
    const stable = clusters.filter((c) => c.sampleIndices.size >= minCount);
    if (stable.length === 0) return { webcamCandidates: [], allFaces: [] };

    const withMeta: ClusterMeta[] = stable.map((c) => ({
      avg: averageBox(c.entries.map((e) => e.box)),
      count: c.sampleIndices.size,
      motion: c.entries.reduce((sum, e) => sum + e.motion, 0) / c.entries.length,
    }));

    return { webcamCandidates: withMeta.filter((m) => isWebcamLike(m.avg, sourceWidth, sourceHeight)), allFaces: withMeta };
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

    const speakerTrace: Array<{ t: string; motion: string; scelto: number | null }> = [];
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
      speakerTrace.push({
        t: seg.startSeconds.toFixed(1),
        motion: anchoredHere.map((c) => `${Math.round(c.anchor.avg.x)}:${c.meta.motion.toFixed(1)}`).join(" "),
        scelto: chosen ? Math.round(chosen.anchor.avg.x) : null,
      });

      return { startSeconds: seg.startSeconds, endSeconds: seg.endSeconds, anchor: chosen?.anchor ?? null };
    });

    // Una riga sola per clip: davanti a un pannello che non cambia mai serve a distinguere "ha
    // parlato una persona sola" da "il movimento della bocca non distingue nessuno".
    logger.info("Chi parla, segmento per segmento (posizione:movimento -> scelto)", { speakerTrace });

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
  // Basta essere lontano dal centro su UN asse: una webcam attaccata al bordo destro a metà
  // altezza è comunque una webcam. Prima si pretendeva un angolo vero (fuori centro su entrambi
  // gli assi) per evitare che un volto dentro il contenuto reagito rubasse il pannello — ma in
  // una call con tre o quattro persone le webcam stanno incolonnate lungo un lato, a metà
  // altezza, e venivano scartate quasi tutte: verificato su una clip reale con 4 webcam, il
  // tracker ne teneva UNA sola e l'inquadratura non cambiava mai. A escludere i volti del
  // contenuto ci pensa ora il riconoscimento del riquadro (vedi webcam-rect.ts), che è un
  // criterio molto più solido della posizione sullo schermo.
  return offCenterX || offCenterY;
}
