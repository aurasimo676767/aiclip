import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import { scoreActiveSpeakers } from "./active-speaker.js";
import { identifyWebcams } from "./face-identity.js";
import { verifySwitchesByVoice } from "./voice-check.js";
import type { CropWindow, FaceTracker, Layout, PeopleHint, Scene, SceneComposition, TimedCrop } from "./face-tracker.js";
import { extractRawFrameBGR, extractRawFrameBGRScaled } from "./frame-extractor.js";
import { detectFaces, type FaceBox } from "./onnx-face-detector.js";
import { computeMouthMotion } from "./mouth-motion.js";
import { centeredCrop } from "./crop-geometry.js";
import { CenterCropFaceTracker } from "./center-crop-face-tracker.js";
import { detectSceneCuts } from "./scene-detect.js";
import { detectWebcamRect, detectWebcamRectDebug } from "./webcam-rect.js";
import { rejectionReasonForWebcamRect } from "./webcam-shape.js";
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

const MIN_ANCHOR_SEGMENT_COVERAGE_RATIO = 0.4; // un volto deve ricomparire in almeno questa frazione dei segmenti per essere considerato "la webcam reale" e non un volto di passaggio nel contenuto reagito

/**
 * Un volto alto almeno questa frazione del frame è il SOGGETTO di quell'inquadratura (streamer a
 * schermo intero), non una faccia dentro il contenuto. Misurato su un VOD già montato: nelle
 * inquadrature a schermo intero il volto era alto il 43-69% del frame, mentre nelle inquadrature
 * con condivisione schermo la cam nell'angolo stava al 10-15%. La soglia sta comoda in mezzo.
 */
const SCENE_SUBJECT_MIN_HEIGHT_RATIO = 0.25;

/**
 * Per quanti secondi di fila la webcam puo' non essere riconosciuta prima di concludere che la
 * scena dello streamer sia proprio cambiata. Conta il tratto CONTIGUO, non il totale: un
 * rilevamento che fallisce qua e la' (volto girato, mano davanti alla bocca) produce buchi da un
 * segmento, e per quelli il layout unico regge benissimo riusando l'ultima posizione valida. Un
 * buco lungo invece e' un'altra inquadratura dello stream, dove quel ritaglio non inquadra niente.
 */
const MAX_ANCHOR_GAP_SECONDS = 2;

/** Quanti volti candidati provare, per scena, nella ricerca del riquadro della webcam. */
const CAM_FACE_TRIES = 3;

/**
 * Un volto per persona: le apparizioni vicine si raggruppano e ognuna vale la sua posizione MEDIA,
 * non la prima incontrata — una webcam vista 20 volte al suo posto e 2 volte spostata (lo streamer
 * che si sporge) deve cercare il riquadro dal suo posto abituale. Con la prima occorrenza, presa da
 * un momento in cui si sporgeva, il riquadro non veniva trovato. Ordine: dal più piccolo.
 */
function distinctFaces(faces: FaceBox[]): FaceBox[] {
  const groups: FaceBox[][] = [];
  for (const f of faces) {
    const group = groups.find((g) => isNearBox(averageBox(g), f));
    if (group) group.push(f);
    else groups.push([f]);
  }
  return groups.map(averageBox).sort((a, b) => a.height - b.height);
}

/** Da quanti secondi di primo piano senza webcam in poi lo stream ha cambiato inquadratura. */
const MIN_SUBJECT_GAP_SECONDS = 1;

/**
 * Il tratto contiguo più lungo (secondi) in cui la webcam non si vede E c'è un volto a tutto
 * schermo (alto almeno SCENE_SUBJECT_MIN_HEIGHT_RATIO del frame).
 */
function longestSubjectGap(decisions: SegmentDecision[], segments: SegmentDetections[], sourceHeight: number): number {
  let best = 0;
  let run = 0;
  decisions.forEach((d, i) => {
    const bigFace = segments[i]?.allFaces.some((f) => f.avg.height >= sourceHeight * SCENE_SUBJECT_MIN_HEIGHT_RATIO) ?? false;
    run = d.anchor === null && bigFace ? run + (d.endSeconds - d.startSeconds) : 0;
    best = Math.max(best, run);
  });
  return best;
}

/** Il tratto contiguo piu' lungo in cui nessun segmento ha un'ancora. */
function longestAnchorGap(decisions: SegmentDecision[]): { startSeconds: number; endSeconds: number; seconds: number } | null {
  let best: { startSeconds: number; endSeconds: number; seconds: number } | null = null;
  let runStart: number | null = null;
  for (const d of decisions) {
    if (d.anchor === null) {
      if (runStart === null) runStart = d.startSeconds;
      const seconds = d.endSeconds - runStart;
      if (!best || seconds > best.seconds) best = { startSeconds: runStart, endSeconds: d.endSeconds, seconds };
    } else {
      runStart = null;
    }
  }
  return best;
}

/** Fotogrammi campionati DENTRO una scena per cercarci la cam e il contenuto. Poche: le scene sono corte. */
const SCENE_SAMPLE_COUNT = 6;

/**
 * Di quanto (frazione della larghezza sorgente) deve spostarsi il soggetto perché valga la pena
 * reinquadrarlo con uno stacco. Il ritaglio è largo ~608px su 1920 e un volto ~300px: oltre ~150px
 * di spostamento il volto comincia a uscire dal ritaglio, sotto è rumore del detector o un gesto.
 */
const REFRAME_THRESHOLD_RATIO = 0.08;
/**
 * Oltre questa larghezza (in multipli del ritaglio 9:16) il "volto" non è un primo piano ma un
 * rilevamento assurdo, e si mostra il frame intero. Non più bassa: un primo piano stretto del
 * montatore, con il volto appena più largo del ritaglio, sta benissimo ritagliato — provato a 0.9
 * sul set di prova, e quei primi piani diventavano un frame piccolo su sfondo sfocato.
 */
const MAX_SUBJECT_WIDTH_IN_CROP = 1.6;
/**
 * Durata minima di un'inquadratura dentro la stessa scena. Un tratto più corto non diventa un
 * ritaglio a sé ma si fonde col vicino: meglio un volto per un attimo un po' decentrato che uno
 * stacco ogni secondo. Misurato sulla clip che l'ha resa necessaria: UN rilevamento a x=1279
 * (streamer piegato in avanti) contro 9 secondi di volto stabile a x≈700-780.
 */
const MIN_REFRAME_SECONDS = 3;

type UnitKind = "split" | "crop" | "fit";

interface CompositionUnit {
  startSeconds: number;
  endSeconds: number;
  kind: UnitKind | null;
  /** Centro orizzontale del soggetto (solo per "crop"; null = nessun volto visto in questo tratto). */
  subjectCx: number | null;
  /** Bordi orizzontali del volto (solo per "crop"), per capire se più posizioni stanno in un ritaglio solo. */
  subjectLeft: number | null;
  subjectRight: number | null;
}

/**
 * Sceglie la composizione della clip TRATTO PER TRATTO (i segmenti di ~1.5s già allineati agli
 * stacchi di montaggio rilevati), non scena per scena.
 *
 * Perché non per scena: la versione precedente decideva una composizione per ogni scena usando
 * il rilevatore di stacchi, e con il "volto più grande della scena" come soggetto. Due difetti
 * osservati su clip reali:
 * - uno stacco non rilevato (zoom del montatore sul video reagito) lasciava "cam sopra +
 *   contenuto sotto" per 2 secondi su un'inquadratura che non aveva più nessuna cam: nel pannello
 *   cam finiva mezza faccia di un'altra persona;
 * - un solo falso/insolito rilevamento grande (lo streamer piegato in avanti per mezzo secondo)
 *   spostava il ritaglio di un'intera scena di 12 secondi sul suo braccio.
 * Decidendo ogni ~1.5s, uno stacco mancato costa al massimo un tratto; e il soggetto si segue con
 * "corse" di posizione stabile (vedi reframeRuns), dove gli scostamenti brevi vengono assorbiti.
 *
 * Il ritaglio resta comunque FERMO: cambia solo con uno stacco netto quando il soggetto si è
 * davvero spostato, mai con un movimento continuo (scelta esplicita di simo, vedi face-tracker.ts).
 */
async function perSceneCompositions(
  sourceVideoPath: string,
  clipStartSeconds: number,
  segments: SegmentDetections[],
  cutTimes: number[],
  clipDuration: number,
  sourceWidth: number,
  sourceHeight: number,
  /**
   * Webcam da mostrare in ogni tratto (allineato a `segments`), scelta da chooseShownSpeakers.
   * Senza, tutta la clip usa una webcam sola: sui video montati con 4 webcam restava fissa quella
   * in alto a sinistra anche quando parlava un altro (segnalato da simo, 2026-10-25).
   */
  shownCams?: CropWindow[],
): Promise<Scene[]> {
  const fullAspect = OUTPUT_RESOLUTION.width / OUTPUT_RESOLUTION.height;
  const boundaries = [0, ...cutTimes.filter((t) => t > 0.01 && t < clipDuration - 0.01), clipDuration];
  const isCut = (t: number) => cutTimes.some((c) => Math.abs(c - t) < 0.05);

  // 1) Il riquadro della cam si cerca per SCENA (serve una stessa inquadratura per più fotogrammi
  //    per vederne i bordi fermi), attorno al volto più PICCOLO e defilato: in una scena di
  //    condivisione schermo il volto più grande è quello dentro il video reagito.
  const cams: CropWindow[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const startSeconds = boundaries[i]!;
    const endSeconds = boundaries[i + 1]!;
    const faces = segments
      .filter((seg) => seg.endSeconds > startSeconds + 0.01 && seg.startSeconds < endSeconds - 0.01)
      .flatMap((seg) => seg.allFaces.map((m) => m.avg));
    // Si provano i volti candidati dal più piccolo, fino a CAM_FACE_TRIES, e si tiene il primo che
    // ha attorno un vero riquadro da webcam: il più piccolo da solo poteva essere una foto profilo
    // nei commenti di Instagram (50x50px), attorno a cui non c'è nessun riquadro — e la cam vera,
    // poco più grande, non veniva mai provata (verificato: scena a frame intero invece che split).
    const camFaces = distinctFaces(faces.filter((f) => isWebcamLike(f, sourceWidth, sourceHeight)).sort((a, b) => a.height - b.height));
    if (camFaces.length === 0) continue;
    const duration = Math.max(0.1, endSeconds - startSeconds);
    const sampleTimes = Array.from({ length: SCENE_SAMPLE_COUNT }, (_, k) => clipStartSeconds + startSeconds + (duration * (k + 0.5)) / SCENE_SAMPLE_COUNT);
    for (const camFace of camFaces.slice(0, CAM_FACE_TRIES)) {
      const found = await detectWebcamRect(sourceVideoPath, sampleTimes, camFace, sourceWidth, sourceHeight);
      if (found && !rejectionReasonForWebcamRect(found, sourceWidth, sourceHeight)) {
        cams.push(found);
        break;
      }
    }
  }
  // UN SOLO riquadro cam per tutta la clip: le scene con la cam sono lo stesso stream ripreso più
  // volte, e riquadri leggermente diversi facevano "respirare" il pannello a ogni stacco.
  const canonicalCam = mostRecurrentRect(cams);

  // 2) Decisione tratto per tratto. Il tratto è "webcam sopra" se si vede il volto in UNA QUALSIASI
  //    delle webcam che si mostrano, non solo in quella di riferimento: sul video di Blur con 4
  //    webcam il riferimento era quella di Pesh (volto piccolo, spesso girato) e nei tratti in cui
  //    il rilevatore non lo vedeva la clip finiva a frame intero rimpicciolito, con le webcam minuscole.
  const camRects = [...new Set([canonicalCam, ...(shownCams ?? [])].filter((c): c is CropWindow => c !== null))];
  const units: CompositionUnit[] = segments.map((seg) => {
    const faces = seg.allFaces.map((m) => m.avg);
    const base = { startSeconds: seg.startSeconds, endSeconds: seg.endSeconds };
    const none = { subjectCx: null, subjectLeft: null, subjectRight: null };
    if (faces.length === 0) return { ...base, kind: null, ...none };
    // Prima la cam: in una reaction il volto più grande è spesso quello del video reagito, e con
    // l'ordine opposto il tratto veniva ritagliato su di lui e lo streamer spariva.
    if (canonicalCam && faces.some((f) => camRects.some((c) => faceFitsInCam(f, c)))) return { ...base, kind: "split", ...none };
    const subject = faces.filter((f) => f.height >= sourceHeight * SCENE_SUBJECT_MIN_HEIGHT_RATIO).sort((a, b) => b.height - a.height)[0];
    // Solo un "volto" enormemente più largo del ritaglio va a frame intero (vedi la costante).
    if (subject && subject.width <= sourceHeight * fullAspect * MAX_SUBJECT_WIDTH_IN_CROP) {
      return { ...base, kind: "crop", subjectCx: subject.x + subject.width / 2, subjectLeft: subject.x, subjectRight: subject.x + subject.width };
    }
    return { ...base, kind: "fit", ...none };
  });

  fillUnknownUnits(units, isCut);
  smoothKindOutliers(units, isCut);
  // Se la clip ha una webcam, mai il gioco a schermo intero senza template (simo, 2026-10-25):
  // restano solo "webcam sopra + gioco sotto" e i primi piani a tutto schermo del montatore.
  if (canonicalCam) for (const u of units) if (u.kind === "fit") u.kind = "split";
  logger.info("Composizione per tratti", {
    cam: canonicalCam,
    tratti: units.map((u) => `${u.startSeconds.toFixed(1)} ${u.kind}`).join(" | "),
  });

  // 3) Pannello contenuto per i tratti in split, SENZA MAI tagliare il contenuto: ritaglio
  //    centrato se il contenuto ci sta, altrimenti la finestra dove succede qualcosa, altrimenti il
  //    frame intero (vedi chooseWithoutCutting in content-region.ts). Prima il ripiego era sempre
  //    il ritaglio centrato, che tagliava le scritte di un quiz largo tutto lo schermo ("sta è
  //    diventata famosa", "Elo", "Rose V").
  //    Provato e scartato, misurando sul set di prova: detectContentBounds (sui video montati
  //    sceglieva il tavolo invece della scena, o la faccia del reagito invece del suo video).
  let topRatio = 0;
  let content: CropWindow | null = null;
  const splitUnits = units.filter((u) => u.kind === "split");
  const camOf = (i: number): CropWindow | null => shownCams?.[i] ?? canonicalCam;
  if (canonicalCam && splitUnits.length > 0) {
    // Un'altezza sola del pannello per tutte le webcam mostrate, così cambiare persona non lo fa saltare.
    topRatio = topRatioForWebcam(units.flatMap((u, i) => (u.kind === "split" ? [camOf(i)!] : [])));
    // Campioni SOLO dai tratti in split: su tutta la clip l'attività delle scene a schermo intero
    // riempiva il frame e ogni ritaglio sembrava tagliare qualcosa (continuazione ~1.0 ovunque).
    const splitSeconds = splitUnits.reduce((sum, u) => sum + (u.endSeconds - u.startSeconds), 0);
    const samples: number[] = [];
    for (let k = 0; k < RECT_SAMPLE_COUNT; k++) {
      let offset = (splitSeconds * (k + 0.5)) / RECT_SAMPLE_COUNT;
      for (const u of splitUnits) {
        const len = u.endSeconds - u.startSeconds;
        if (offset <= len) {
          samples.push(clipStartSeconds + u.startSeconds + offset);
          break;
        }
        offset -= len;
      }
    }
    const bottomAspect = OUTPUT_RESOLUTION.width / (OUTPUT_RESOLUTION.height * (1 - topRatio));
    const region = await detectContentRegion(sourceVideoPath, samples, sourceWidth, sourceHeight, bottomAspect, [canonicalCam, ...(shownCams ?? [])], true);
    content = region ?? { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  }

  // 4) Ritagli: posizione del soggetto per "corse" stabili, poi un Scene per tratto.
  const cropCx = reframeRuns(units, isCut, sourceWidth * REFRAME_THRESHOLD_RATIO, sourceHeight * fullAspect);
  const scenes: Scene[] = units.map((u, i) => {
    const base = { startSeconds: u.startSeconds, endSeconds: u.endSeconds };
    if (u.kind === "split" && canonicalCam && content) {
      return { ...base, composition: { kind: "split", cam: camOf(i)!, content, topRatio } };
    }
    if (u.kind === "crop" && cropCx[i] !== null && cropCx[i] !== undefined) {
      return { ...base, composition: { kind: "crop", crop: centeredCrop(cropCx[i]!, sourceHeight / 2, sourceWidth, sourceHeight, fullAspect) } };
    }
    return { ...base, composition: { kind: "fit" } };
  });

  return mergeAdjacentScenes(scenes, sourceWidth);
}

/**
 * Tratti dove il detector non ha visto nessun volto (girato, coperto, o un'inquadratura senza
 * persone): prendono la decisione del tratto precedente se non c'è uno stacco in mezzo, altrimenti
 * del successivo. Un'intera scena senza volti resta "fit" (gameplay/schermo a tutto campo).
 */
function fillUnknownUnits(units: CompositionUnit[], isCut: (t: number) => boolean): void {
  for (let i = 1; i < units.length; i++) {
    const u = units[i]!;
    const prev = units[i - 1]!;
    if (u.kind === null && prev.kind !== null && !isCut(u.startSeconds)) u.kind = prev.kind;
  }
  for (let i = units.length - 2; i >= 0; i--) {
    const u = units[i]!;
    const next = units[i + 1]!;
    if (u.kind === null && next.kind !== null && !isCut(next.startSeconds)) u.kind = next.kind;
  }
  for (const u of units) if (u.kind === null) u.kind = "fit";
}

/**
 * Un tratto singolo di tipo diverso dai due vicini (che invece coincidono), senza stacchi ai suoi
 * bordi, è quasi sempre un errore di rilevamento e non un cambio vero: prende il tipo dei vicini.
 */
function smoothKindOutliers(units: CompositionUnit[], isCut: (t: number) => boolean): void {
  for (let i = 1; i < units.length - 1; i++) {
    const prev = units[i - 1]!;
    const u = units[i]!;
    const next = units[i + 1]!;
    if (u.kind === prev.kind || prev.kind !== next.kind) continue;
    if (isCut(u.startSeconds) || isCut(next.startSeconds)) continue;
    u.kind = prev.kind;
    u.subjectCx = null;
    u.subjectLeft = null;
    u.subjectRight = null;
  }
}

/**
 * Centro del ritaglio per ogni tratto "crop" (null per gli altri).
 *
 * I tratti crop consecutivi senza stacchi in mezzo formano uno "span"; dentro lo span la posizione
 * del soggetto si divide in corse (una nuova corsa parte quando il volto si allontana oltre la
 * soglia dalla mediana della corsa), poi le corse più corte di MIN_REFRAME_SECONDS vengono fuse
 * nella vicina più lunga. Ogni corsa rimasta è un ritaglio fermo sulla mediana delle sue posizioni:
 * la mediana, non la media, così un rilevamento spurio non sposta l'inquadratura.
 */
function reframeRuns(units: CompositionUnit[], isCut: (t: number) => boolean, threshold: number, cropWidth: number): Array<number | null> {
  const result: Array<number | null> = units.map(() => null);

  let i = 0;
  while (i < units.length) {
    if (units[i]!.kind !== "crop") {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < units.length && units[j + 1]!.kind === "crop" && !isCut(units[j + 1]!.startSeconds)) j++;

    interface Run {
      from: number;
      to: number;
      positions: number[];
    }
    const runs: Run[] = [];
    for (let k = i; k <= j; k++) {
      const cx = units[k]!.subjectCx;
      const current = runs[runs.length - 1];
      if (current && (cx === null || Math.abs(cx - median(current.positions)) <= threshold || current.positions.length === 0)) {
        current.to = k;
        if (cx !== null) current.positions.push(cx);
      } else {
        runs.push({ from: k, to: k, positions: cx === null ? [] : [cx] });
      }
    }

    const runSeconds = (r: Run) => units[r.to]!.endSeconds - units[r.from]!.startSeconds;
    while (runs.length > 1) {
      let shortest = -1;
      for (let r = 0; r < runs.length; r++) {
        if (runSeconds(runs[r]!) < MIN_REFRAME_SECONDS && (shortest < 0 || runSeconds(runs[r]!) < runSeconds(runs[shortest]!))) shortest = r;
      }
      if (shortest < 0) break;
      const left = runs[shortest - 1];
      const right = runs[shortest + 1];
      const target = !left ? right! : !right ? left : runSeconds(left) >= runSeconds(right) ? left : right;
      const absorbed = runs[shortest]!;
      target.from = Math.min(target.from, absorbed.from);
      target.to = Math.max(target.to, absorbed.to);
      // Le posizioni del tratto assorbito NON entrano nella mediana: era troppo breve per contare,
      // ed è proprio lo scostamento che non deve spostare l'inquadratura.
      runs.splice(shortest, 1);
    }

    for (const run of runs) {
      let cx = run.positions.length > 0 ? median(run.positions) : null;
      // Se TUTTE le posizioni del volto nella corsa (anche quelle dei tratti brevi assorbiti) stanno
      // insieme nel ritaglio, lo si centra sull'insieme: la mediana sola, su uno streamer che gira la
      // testa, lasciava fuori mezza faccia nei momenti in cui si voltava (verificato su una clip
      // vera). Se non ci stanno — un rilevamento lontano, lo streamer piegato fuori campo — resta la
      // mediana, che ignora lo scostamento.
      const lefts: number[] = [];
      const rights: number[] = [];
      for (let k = run.from; k <= run.to; k++) {
        const u = units[k]!;
        if (u.subjectLeft !== null && u.subjectRight !== null) {
          lefts.push(u.subjectLeft);
          rights.push(u.subjectRight);
        }
      }
      if (cx !== null && lefts.length > 0) {
        const left = Math.min(...lefts);
        const right = Math.max(...rights);
        if (right - left <= cropWidth * 0.95) cx = (left + right) / 2;
      }
      for (let k = run.from; k <= run.to; k++) result[k] = cx;
    }
    // Uno span in cui nessun tratto ha visto il volto non può restare un ritaglio al buio.
    for (let k = i; k <= j; k++) if (result[k] === null) units[k]!.kind = "fit";
    i = j + 1;
  }
  return result;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Il volto è quello DENTRO la cam: centro nel riquadro e dimensioni da cam. Il solo centro non
 * basta — in un primo piano del montatore sul video reagito, una faccia alta il doppio del
 * riquadro aveva il centro proprio nell'angolo della cam, e il tratto finiva "cam sopra" con mezza
 * faccia di un'altra persona nel pannello.
 */
function faceFitsInCam(face: FaceBox, cam: CropWindow): boolean {
  return faceCenterInside(face, cam) && face.height <= cam.height * 0.85 && face.width <= cam.width * 0.85;
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
    sceneCuts?: boolean;
    people?: PeopleHint;
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
      if (params.sceneCuts !== false) cutTimes = await detectSceneCuts(sourceVideoPath, startSeconds, clipDuration);
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
    const rectAlternatives = new Map<PositionGroup, Array<{ rect: CropWindow; score: number }>>();
    for (const anchor of candidateAnchors) {
      const found = await detectWebcamRectDebug(sourceVideoPath, sampleTimes, anchor.avg, sourceWidth, sourceHeight);
      rectAlternatives.set(anchor, found.alternatives);
      if (found.rect) cropByAnchor.set(anchor, found.rect);
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
    fixOversizedWebcamRects(anchorGroups, cropByAnchor, rectAlternatives, sourceWidth, sourceHeight);
    const decisions = rawDecisions.map((d) => ({ ...d, anchor: d.anchor && cropByAnchor.has(d.anchor) ? d.anchor : null }));

    // Con più webcam, CHI mostrare lo decide il modello chi-parla insieme al proprietario del canale
    // (vedi chooseShownSpeakers). `decisions` resta com'è perché serve a capire dove le webcam ci sono.
    const shownIndex =
      anchorGroups.length >= 2
        ? await chooseShownSpeakers({
            sourceVideoPath,
            sourceWidth,
            sourceHeight,
            startSeconds,
            clipDuration,
            anchors: anchorGroups,
            segments: decisions,
            people: params.people,
          })
        : null;
    // Senza il modello (una webcam sola, o modello fallito) si mostrano comunque le webcam riconosciute
    // come tali, mai il riquadro "di riferimento" del percorso per scene: quello si cerca attorno al
    // volto più PICCOLO, e sul video di Blur era la webcam di Pesh, in alto in ogni clip.
    const shownCams = shownIndex
      ? shownIndex.map((k) => cropByAnchor.get(anchorGroups[k]!)!)
      : anchorGroups.length > 0
        ? decisions.map((d) => cropByAnchor.get(d.anchor ?? anchorGroups[0]!)!)
        : undefined;

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


    // La clip puo' contenere PIU' scene dello streamer, non una sola: qui succede quando lo
    // streamer alterna "webcam a schermo intero" e "condivisione schermo con la cam in un angolo".
    // Il layout unico per l'intera clip incolla allora il ritaglio della cam piccola anche sopra i
    // tratti a webcam intera, dove quel rettangolo non inquadra niente — verificato su una clip
    // reale, i primi 6 secondi mostravano un muro sfocato. In quel caso si passa al percorso che
    // sceglie la composizione scena per scena. Si rinuncia al cambio di inquadratura per speaker
    // dentro le scene, ma e' un prezzo minore rispetto a mezza clip inquadrata su un muro.
    // Prova diretta, prima di quella sul riquadro: dove la webcam non si vede e c'è invece un volto
    // a tutto schermo, lo stream ha cambiato inquadratura (primo piano dello streamer, o del video
    // reagito) — lì il ritaglio della cam inquadra un pezzo di qualcos'altro. Verificato su una clip
    // vera: 3.5s finali a primo piano mostrati come "cam" = una spalla, perché il controllo sul
    // riquadro qui sotto trovava per caso bordi nello stesso punto.
    const subjectGap = longestSubjectGap(decisions, rawSegments, sourceHeight);
    if (subjectGap >= MIN_SUBJECT_GAP_SECONDS) {
      logger.info("Primo piano a tutto schermo dove la webcam non c'è: composizione scelta per tratti", {
        trattoPrimoPiano: subjectGap.toFixed(1) + "s",
      });
      const scenes = await perSceneCompositions(sourceVideoPath, startSeconds, rawSegments, cutTimes, clipDuration, sourceWidth, sourceHeight, shownCams);
      if (scenes.length) return { type: "scenes", scenes };
    }

    const gap = longestAnchorGap(decisions);
    if (gap && gap.seconds > MAX_ANCHOR_GAP_SECONDS) {
      // Un buco lungo puo' voler dire due cose OPPOSTE: la webcam c'e' ancora ma il detector non
      // ha visto il volto (girato, coperto, di spalle), oppure lo stream ha proprio cambiato
      // inquadratura e li' non c'e' nessuna webcam. Sulla sola durata non si distinguono — provato,
      // e la soglia che sistemava una clip ne rompeva un'altra. Si guarda quindi la cosa giusta:
      // il RIQUADRO dell'overlay e' ancora li' in quel tratto? Il riquadro e' un bordo fermo e
      // marcato, si vede anche senza riconoscere nessun volto.
      const gapSamples = Array.from(
        { length: SCENE_SAMPLE_COUNT },
        (_, k) => startSeconds + gap.startSeconds + ((gap.endSeconds - gap.startSeconds) * (k + 0.5)) / SCENE_SAMPLE_COUNT,
      );
      const mainAnchor = anchorGroups[0]!;
      const known = cropByAnchor.get(mainAnchor)!;
      const stillThere = await detectWebcamRect(sourceVideoPath, gapSamples, mainAnchor.avg, sourceWidth, sourceHeight);
      const overlayPersists =
        stillThere !== null &&
        Math.abs(stillThere.x - known.x) <= SAME_RECT_TOLERANCE_PX &&
        Math.abs(stillThere.y - known.y) <= SAME_RECT_TOLERANCE_PX;

      if (!overlayPersists) {
        logger.info("La scena dello streamer cambia dentro la clip: composizione scelta scena per scena", {
          trattoSenzaWebcam: gap.seconds.toFixed(1) + "s",
          durata: clipDuration.toFixed(1) + "s",
        });
        const scenes = await perSceneCompositions(sourceVideoPath, startSeconds, rawSegments, cutTimes, clipDuration, sourceWidth, sourceHeight, shownCams);
        if (scenes.length) return { type: "scenes", scenes };
      }
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
    // Se i bordi non sono credibili, stessa scelta "senza tagli" dei video montati: ritaglio
    // centrato se il contenuto ci sta, altrimenti il frame intero. Prima il ripiego era sempre il
    // ritaglio centrato, a costo di tagliare il contenuto.
    const bottom =
      contentBounds ??
      (await detectContentRegion(sourceVideoPath, sampleTimes, sourceWidth, sourceHeight, bottomAspect, [...cropByAnchor.values()], true)) ?? {
        x: 0,
        y: 0,
        width: sourceWidth,
        height: sourceHeight,
      };
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
      crop: shownCams?.[i] ?? cropByAnchor.get(d.anchor ?? nearestAnchor(decisions, i))!,
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
 * Oltre quante volte la proporzione riquadro/volto delle ALTRE webcam un riquadro è sicuramente
 * troppo grande. In un layout con più webcam le webcam sono della stessa taglia: sul video di Blur
 * il riquadro valeva 4,7-4,8 volte la larghezza del volto per tre webcam, e 7,2 per quella di
 * Manuxo, che si era presa anche la finestra azzurra del gioco dietro (bordi nettissimi).
 */
const OVERSIZED_RECT_RATIO = 1.35;
/** Punteggio minimo (assoluto e relativo al migliore) di un'alternativa per prendere il posto di un riquadro troppo grande. */
const MIN_ALTERNATIVE_SCORE = 10;
const MIN_ALTERNATIVE_SCORE_SHARE = 0.2;
/** Due riquadri sono "della stessa taglia" se larghezza e altezza differiscono al massimo di questo fattore (le tessere del video di Blur: 336-398 px). */
const SAME_TILE_RATIO = 1.2;

/**
 * Con più webcam, un riquadro molto più grande (rispetto al suo volto) di quelli delle altre si
 * sostituisce con l'alternativa trovata dallo stesso rilevatore che ha le proporzioni delle altre,
 * se abbastanza convincente. Agisce solo sui riquadri troppo GRANDI: uno troppo grande si porta
 * dentro un pezzo di gioco e rimpicciolisce la persona nel pannello.
 */
function fixOversizedWebcamRects(
  anchors: PositionGroup[],
  cropByAnchor: Map<PositionGroup, CropWindow>,
  alternatives: Map<PositionGroup, Array<{ rect: CropWindow; score: number }>>,
  sourceWidth: number,
  sourceHeight: number,
): void {
  if (anchors.length < 2) return;
  const ratio = (a: PositionGroup, r: CropWindow) => r.width / a.avg.width;
  const credible = (a: PositionGroup) => {
    const alts = alternatives.get(a) ?? [];
    const best = alts[0]?.score ?? 0;
    return alts.filter(
      (alt) =>
        alt.score >= Math.max(MIN_ALTERNATIVE_SCORE, best * MIN_ALTERNATIVE_SCORE_SHARE) &&
        faceCenterInside(a.avg, alt.rect) &&
        !rejectionReasonForWebcamRect(alt.rect, sourceWidth, sourceHeight),
    );
  };
  const similar = (r: CropWindow, s: CropWindow) =>
    Math.max(r.width, s.width) / Math.min(r.width, s.width) <= SAME_TILE_RATIO && Math.max(r.height, s.height) / Math.min(r.height, s.height) <= SAME_TILE_RATIO;

  // Con più webcam (videochiamata di gruppo, overlay a griglia) le webcam sono tessere della
  // stessa taglia: un riquadro che non somiglia a NESSUN riquadro possibile delle altre webcam è
  // sbagliato, e si sceglie tra le sue alternative quella che ne somiglia di più. Misurato sul video
  // di Blur con 4 webcam: tessere fra 336 e 398 px di larghezza, e riquadri sbagliati di 510-604 px
  // che si portavano dentro la finestra del gioco. La proporzione col volto deve restare simile a
  // quella delle altre webcam: così la webcam GRANDE di uno streamer con due ospiti piccoli (il suo
  // volto è grande anche lui) non viene mai ristretta a un pezzo interno della taglia degli ospiti.
  {
    for (let pass = 0; pass < 2; pass++) {
      for (const anchor of anchors) {
        const current = cropByAnchor.get(anchor)!;
        const others = anchors.filter((a) => a !== anchor);
        const support = (r: CropWindow) => others.filter((o) => credible(o).some((c) => similar(c.rect, r))).length;
        if (support(current) > 0) continue;
        const typical = median(others.map((o) => ratio(o, cropByAnchor.get(o)!)));
        const pick = credible(anchor)
          .filter(
            (c) =>
              c.rect.width * c.rect.height < current.width * current.height &&
              support(c.rect) >= Math.min(2, others.length) &&
              ratio(anchor, c.rect) >= typical * 0.75 &&
              ratio(anchor, c.rect) <= typical * OVERSIZED_RECT_RATIO,
          )
          .sort((a, b) => support(b.rect) - support(a.rect) || b.score - a.score)[0];
        if (!pick) continue;
        logger.info("Riquadro webcam diverso da tutte le altre webcam del layout: preso quello della loro taglia", {
          face: anchor.avg,
          prima: current,
          dopo: pick.rect,
          webcamSimili: support(pick.rect),
        });
        cropByAnchor.set(anchor, pick.rect);
      }
    }
  }

  // Con 2 webcam, o se la griglia non ha deciso: proporzione col volto molto più grande delle altre.
  for (const anchor of anchors) {
    const rect = cropByAnchor.get(anchor)!;
    const others = anchors.filter((a) => a !== anchor).map((a) => ratio(a, cropByAnchor.get(a)!));
    const typical = median(others);
    if (ratio(anchor, rect) <= typical * OVERSIZED_RECT_RATIO) continue;
    const alts = alternatives.get(anchor) ?? [];
    const best = alts[0]?.score ?? 0;
    const replacement = alts
      .filter(
        (alt) =>
          alt.score >= Math.max(MIN_ALTERNATIVE_SCORE, best * MIN_ALTERNATIVE_SCORE_SHARE) &&
          ratio(anchor, alt.rect) <= typical * OVERSIZED_RECT_RATIO &&
          faceCenterInside(anchor.avg, alt.rect) &&
          !rejectionReasonForWebcamRect(alt.rect, sourceWidth, sourceHeight),
      )
      .sort((a, b) => Math.abs(ratio(anchor, a.rect) - typical) - Math.abs(ratio(anchor, b.rect) - typical))[0];
    logger.info("Riquadro webcam troppo grande rispetto alle altre webcam", {
      face: anchor.avg,
      rect,
      proporzione: ratio(anchor, rect).toFixed(2),
      tipicaAltre: typical.toFixed(2),
      sostituitoCon: replacement?.rect ?? "nessuna alternativa credibile, resta com'è",
    });
    if (replacement) cropByAnchor.set(anchor, replacement.rect);
  }
}

/**
 * Quanto il punteggio del proprietario può stare sotto quello di un altro e restare comunque lui
 * in scena, quando parlano insieme ("se sta parlando proprio lui deve esserci lui", simo).
 */
const OWNER_KEEP_TOLERANCE = 1.5;
/** Punteggio minimo (modello chi-parla, >0 = parla) perché un ALTRO prenda il pannello: un po' sopra lo zero, per non cambiare su un dubbio. */
const OTHER_SPEAKER_MIN_SCORE = 0.5;

/**
 * Chi mostrare nel pannello webcam, tratto per tratto, con la regola di simo (2026-10-25):
 * - di base il PROPRIETARIO del canale: quando nessuno parla o parla lui;
 * - quando parla un altro, quello che parla;
 * - appena torna il silenzio, di nuovo il proprietario.
 *
 * "Chi parla" lo dice il modello chi-parla (active-speaker.ts), che guarda bocca e voce insieme:
 * chi è mutato e muove la bocca per i fatti suoi non vale. Il proprietario si riconosce dalle foto
 * etichettate da simo (face-identity.ts); se non si riconosce, è chi parla di più nella clip.
 * Ritorna per ogni tratto l'indice in `anchors`, o null se il modello non è utilizzabile (allora
 * resta la scelta col solo movimento della bocca).
 */
async function chooseShownSpeakers(p: {
  sourceVideoPath: string;
  sourceWidth: number;
  sourceHeight: number;
  startSeconds: number;
  clipDuration: number;
  anchors: PositionGroup[];
  segments: Array<{ startSeconds: number; endSeconds: number }>;
  people?: PeopleHint;
}): Promise<number[] | null> {
  let scores: number[][];
  let fps: number;
  try {
    ({ scores, fps } = await scoreActiveSpeakers(p.sourceVideoPath, p.startSeconds, p.clipDuration, p.anchors.map((a) => a.avg), p.sourceWidth, p.sourceHeight));
  } catch (err) {
    logger.warn("Modello chi-parla non disponibile, scelgo la webcam col solo movimento della bocca", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const meanIn = (k: number, from: number, to: number) => {
    const s = scores[k] ?? [];
    const a = Math.max(0, Math.floor(from * fps));
    const b = Math.min(s.length, Math.max(a + 1, Math.ceil(to * fps)));
    let sum = 0;
    for (let i = a; i < b; i++) sum += s[i]!;
    return b > a ? sum / (b - a) : -1;
  };

  // Proprietario: dalle foto della pagina Facce, guardando ogni webcam nei momenti in cui il suo
  // volto c'era davvero (nei primi piani del montatore il ritaglio cadrebbe su un altro).
  let owner = -1;
  let identities: Array<string | null> = [];
  if (p.people?.ownerLabel && p.people.references.length) {
    try {
      const times = p.anchors.map((a) => {
        const segs = [...a.segIndices].sort((x, y) => x - y);
        const picks = segs.length <= 4 ? segs : [0, 1, 2, 3].map((q) => segs[Math.round((q * (segs.length - 1)) / 3)]!);
        return picks.map((i) => p.startSeconds + (p.segments[i]!.startSeconds + p.segments[i]!.endSeconds) / 2);
      });
      const ids = await identifyWebcams(p.sourceVideoPath, times, p.anchors.map((a) => a.avg), p.sourceWidth, p.sourceHeight, p.people.references);
      identities = ids.map((id) => id.label);
      const ownerLabel = p.people.ownerLabel;
      const candidates = ids.map((id, k) => ({ ...id, k })).filter((id) => id.label === ownerLabel).sort((a, b) => b.similarity - a.similarity);
      owner = candidates[0]?.k ?? -1;
    } catch (err) {
      logger.warn("Riconoscimento del proprietario fallito, uso chi parla di più", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const ownerFromPhotos = owner >= 0;
  if (!ownerFromPhotos) {
    const talk = scores.map((s) => s.reduce((sum, v) => sum + Math.max(0, v), 0));
    owner = talk.indexOf(Math.max(...talk));
  }

  const trace: string[] = [];
  const segmentMeans = p.segments.map((seg) => p.anchors.map((_, k) => meanIn(k, seg.startSeconds, seg.endSeconds)));
  const chosen = p.segments.map((seg, i) => {
    const means = segmentMeans[i]!;
    const ownerScore = means[owner]!;
    let bestOther = -1;
    for (let k = 0; k < means.length; k++) if (k !== owner && (bestOther < 0 || means[k]! > means[bestOther]!)) bestOther = k;
    let pick = owner;
    if (!(ownerScore > 0 && ownerScore >= (means[bestOther] ?? -Infinity) - OWNER_KEEP_TOLERANCE) && bestOther >= 0 && means[bestOther]! >= OTHER_SPEAKER_MIN_SCORE) {
      pick = bestOther;
    }
    trace.push(`${seg.startSeconds.toFixed(1)} ${means.map((m) => m.toFixed(1)).join("/")}→${pick}`);
    return pick;
  });
  // Un tratto cortissimo (stacco del montatore vicino al confine) non fa cambiare persona da solo.
  for (let i = 1; i < chosen.length; i++) {
    const seg = p.segments[i]!;
    if (seg.endSeconds - seg.startSeconds < 0.5) chosen[i] = chosen[i - 1]!;
  }

  logger.info("Chi parla (modello bocca+voce) e chi va nel pannello", {
    webcam: p.anchors.map((a, k) => `${k}@${Math.round(a.avg.x)},${Math.round(a.avg.y)}${identities[k] ? `=${identities[k]}` : ""}`),
    proprietario: `${owner}${ownerFromPhotos ? ` (${p.people!.ownerLabel}, dalle foto)` : " (chi parla di più)"}`,
    tratti: trace.join(" | "),
  });

  // Prima di togliere il proprietario, la voce di quei tratti deve essere davvero di chi si mostra
  // (vedi voice-check.ts): una voce del gioco o di un video non è di nessuna webcam.
  if (!chosen.some((k) => k !== owner)) return chosen;
  try {
    return await verifySwitchesByVoice({ videoPath: p.sourceVideoPath, startSeconds: p.startSeconds, segments: p.segments, means: segmentMeans, chosen, owner });
  } catch (err) {
    logger.warn("Controllo voce non riuscito, tengo la scelta del modello chi-parla", { error: err instanceof Error ? err.message : String(err) });
    return chosen;
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
