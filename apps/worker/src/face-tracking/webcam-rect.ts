import { extractRawFrameBGRScaled } from "./frame-extractor.js";
import { logger } from "../lib/logger.js";
import type { CropWindow } from "./face-tracker.js";
import type { FaceBox } from "./onnx-face-detector.js";

/** Risoluzione di analisi: abbastanza per vedere una linea di bordo, abbastanza bassa da restare economica. */
const ANALYSIS_WIDTH = 960;

/** Quanto lontano dal volto cercare i bordi, in multipli della dimensione del volto. */
const MIN_SEARCH_FACES = 0.25;
const MAX_SEARCH_FACES = 6;

/**
 * Un bordo credibile deve staccare di almeno questo fattore rispetto al contrasto tipico della
 * fascia esplorata. Sotto questa soglia si preferisce dichiarare "non trovato" e lasciare che il
 * chiamante ricada sul ritaglio attorno al volto, invece di inventare un bordo sbagliato.
 */
const CANDIDATE_STRENGTH_RATIO = 1.5;

/** Quanti candidati tenere per lato: oltre questi il costo della combinatoria non ripaga. */
const MAX_CANDIDATES_PER_SIDE = 6;

/** Quanto largo il vicinato in cui una posizione deve essere massimo locale per valere come candidato. */
const LOCAL_MAX_WINDOW = 3;

/**
 * Percentile usato per valutare quanto un bordo è CONTINUO lungo la fascia. Un bordo vero di un
 * riquadro attraversa tutta l'altezza (o larghezza) dell'overlay, quindi resta forte anche nel suo
 * punto più debole; il contorno di un oggetto del gioco copre solo un pezzo della fascia, quindi
 * un percentile basso lo penalizza. Distinguere così serve perché su alcuni giochi lo sfondo ha
 * strisce nette (verificato: le strisce verticali di Fall Guys ingannavano una semplice media).
 */
const CONTINUITY_PERCENTILE = 0.3;

/**
 * Sotto questo punteggio (differenza di luminosità, scala 0-255) il "riquadro" migliore trovato non
 * è un bordo vero. Misurato su casi reali: le webcam vere hanno dato 11, 28 e 33, mentre un volto
 * dentro il contenuto (una foto profilo nei commenti di Instagram) ha dato 0.4 — il divario è netto
 * e la soglia sta comodamente in mezzo, dalla parte prudente.
 */
const MIN_RECT_SCORE = 4;

/**
 * Quanto deve essere alto il volto rispetto al riquadro che lo contiene perché quel riquadro sia
 * credibile come webcam. Su webcam reali misurato 28-39%; sotto questa soglia si tratta quasi
 * sempre di un volto dentro il contenuto reagito (una faccia in un TikTok dentro il suo player).
 */
const MIN_FACE_TO_RECT_RATIO = 0.18;

/** Entro questa frazione del punteggio migliore due rettangoli si considerano equivalenti (vedi sotto). */
const NEAR_TIE_RATIO = 0.85;

export interface WebcamRectDebug {
  rect: CropWindow | null;
  reason: string;
  /** I migliori rettangoli valutati, dal più convincente: serve agli script di verifica per capire perché ha scelto quello. */
  alternatives: Array<{ rect: CropWindow; score: number }>;
}

/**
 * Trova il rettangolo dell'overlay webcam attorno a un volto.
 *
 * Idea: un overlay webcam è FERMO nel frame per tutta la clip, mentre il gioco/video dietro si
 * muove. Mediando la mappa dei contorni su più fotogrammi distribuiti nella clip, i bordi del
 * riquadro (sempre negli stessi pixel) si sommano, mentre quelli del contenuto in movimento si
 * annacquano. Sulla mappa così ottenuta si cercano, ai quattro lati del volto, le linee dritte e
 * CONTINUE che delimitano il riquadro. Se un lato non ha una linea credibile ma il volto è vicino
 * al bordo del frame, si usa il bordo del frame (caso tipico: overlay incollato a un angolo).
 *
 * Ritorna null se non ne esce un rettangolo plausibile: meglio il ripiego del chiamante che un
 * ritaglio inventato.
 */
export async function detectWebcamRect(
  videoPath: string,
  sampleTimes: number[],
  face: FaceBox,
  sourceWidth: number,
  sourceHeight: number,
): Promise<CropWindow | null> {
  const result = await detectWebcamRectDebug(videoPath, sampleTimes, face, sourceWidth, sourceHeight);
  return result.rect;
}

/** Come detectWebcamRect ma spiega anche perché ha (o non ha) deciso: usato dagli script di verifica. */
export async function detectWebcamRectDebug(
  videoPath: string,
  sampleTimes: number[],
  face: FaceBox,
  sourceWidth: number,
  sourceHeight: number,
): Promise<WebcamRectDebug> {
  const scale = ANALYSIS_WIDTH / sourceWidth;
  const width = ANALYSIS_WIDTH;
  const height = Math.round((sourceHeight * scale) / 2) * 2;

  const edges = await buildPersistentEdgeMap(videoPath, sampleTimes, width, height);
  if (!edges) return { rect: null, reason: "estrazione fotogrammi fallita", alternatives: [] };

  const f = { x: face.x * scale, y: face.y * scale, width: face.width * scale, height: face.height * scale };

  // La fascia lungo cui misurare la continuità di un bordo VERTICALE: l'altezza plausibile
  // dell'overlay attorno al volto. Idem, trasposta, per i bordi orizzontali.
  const vBandTop = clampInt(f.y - f.height * 1.2, 0, height - 1);
  const vBandBottom = clampInt(f.y + f.height * 2.2, 0, height - 1);
  const hBandLeft = clampInt(f.x - f.width * 1.5, 0, width - 1);
  const hBandRight = clampInt(f.x + f.width * 2.5, 0, width - 1);

  // Candidati per ogni lato (il bordo del frame è sempre un candidato: un overlay incollato al
  // margine dello schermo non ha una linea propria da quel lato).
  const leftCandidates = [
    0,
    ...borderCandidates(edges.gx, width, "column", vBandTop, vBandBottom, clampInt(f.x - f.width * MAX_SEARCH_FACES, 1, width - 2), clampInt(f.x - f.width * MIN_SEARCH_FACES, 1, width - 2)),
  ];
  const rightCandidates = [
    width - 1,
    ...borderCandidates(edges.gx, width, "column", vBandTop, vBandBottom, clampInt(f.x + f.width * (1 + MIN_SEARCH_FACES), 1, width - 2), clampInt(f.x + f.width * MAX_SEARCH_FACES, 1, width - 2)),
  ];
  const topCandidates = [
    0,
    ...borderCandidates(edges.gy, width, "row", hBandLeft, hBandRight, clampInt(f.y - f.height * MAX_SEARCH_FACES, 1, height - 2), clampInt(f.y - f.height * MIN_SEARCH_FACES, 1, height - 2)),
  ];
  const bottomCandidates = [
    height - 1,
    ...borderCandidates(edges.gy, width, "row", hBandLeft, hBandRight, clampInt(f.y + f.height * (1 + MIN_SEARCH_FACES), 1, height - 2), clampInt(f.y + f.height * MAX_SEARCH_FACES, 1, height - 2)),
  ];

  // I quattro lati NON si scelgono indipendentemente: ognuno preso per conto suo si ferma sul
  // primo stacco che incontra, che spesso è dentro la webcam (lo schienale della sedia, il bordo
  // di un mobile) — verificato in pratica, i rettangoli uscivano tagliati dentro. Si valuta invece
  // ogni combinazione come RETTANGOLO: il suo punteggio è il PIÙ DEBOLE dei suoi quattro lati,
  // misurato lungo l'intera lunghezza del lato. Così vince solo un rettangolo i cui quattro lati
  // sono tutti bordi veri e continui — che è esattamente ciò che distingue il riquadro di un
  // overlay da uno stacco qualsiasi dentro l'immagine.
  const evaluated: Array<{ rect: CropWindow; score: number }> = [];
  for (const x0 of leftCandidates) {
    for (const x1 of rightCandidates) {
      if (x1 - x0 < 8) continue;
      for (const y0 of topCandidates) {
        for (const y1 of bottomCandidates) {
          if (y1 - y0 < 8) continue;

          const rect: CropWindow = {
            x: Math.round(x0 / scale),
            y: Math.round(y0 / scale),
            width: Math.round((x1 - x0) / scale),
            height: Math.round((y1 - y0) / scale),
          };
          if (implausibleReason(rect, face, sourceWidth, sourceHeight)) continue;

          evaluated.push({ rect, score: rectangleScore(edges, width, height, x0, x1, y0, y1) });
        }
      }
    }
  }

  // A parità SOSTANZIALE di punteggio vince il rettangolo più grande. Un rettangolo contenuto
  // dentro quello vero prende quasi lo stesso punteggio — i suoi lati cadono su bordi interni alla
  // webcam (lo schienale, un mobile) che sono comunque netti — ma taglia via una fetta di
  // inquadratura. Verificato su due webcam reali dello stesso VOD: i riquadri giusti perdevano
  // rispettivamente del 5% e del 12% contro un proprio ritaglio interno, e uno dei due usciva
  // quasi verticale (che in uno Short si vedrebbe malissimo). Con questa tolleranza vincono
  // entrambi i riquadri veri, e su tutti i video provati non è mai passato un rettangolo più
  // largo del vero.
  const sortedByScore = [...evaluated].sort((a, b) => b.score - a.score);
  const topScore = sortedByScore[0]?.score ?? 0;
  const contenders = sortedByScore.filter((e) => e.score >= topScore * NEAR_TIE_RATIO);
  const ranked = [
    ...contenders.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height),
    ...sortedByScore.filter((e) => e.score < topScore * NEAR_TIE_RATIO),
  ].slice(0, 5);
  const best = ranked[0];
  if (!best) return { rect: null, reason: "nessun rettangolo plausibile attorno al volto", alternatives: [] };
  if (best.score < MIN_RECT_SCORE) {
    return {
      rect: null,
      reason: `bordi troppo deboli per essere un riquadro (${best.score.toFixed(1)} < ${MIN_RECT_SCORE})`,
      alternatives: ranked,
    };
  }
  return { rect: best.rect, reason: `ok (bordo più debole ${best.score.toFixed(1)})`, alternatives: ranked };
}

/**
 * Quanto un rettangolo è "bordato" davvero: il punteggio è quello del suo lato PIÙ DEBOLE, e ogni
 * lato è valutato col percentile basso dei contorni lungo tutta la sua lunghezza. Serve il minimo,
 * non la media: tre lati fortissimi e uno inesistente non fanno un riquadro.
 *
 * I lati che coincidono col bordo del FRAME non vengono contati: lì un contorno non può esserci
 * (fuori non c'è immagine), e includerli azzerava il punteggio di ogni overlay attaccato al bordo
 * dello schermo — che è il caso più comune — facendo vincere rettangoli sbagliati (verificato su
 * un fotogramma reale: la webcam in basso a destra veniva allargata fin dentro il gioco).
 */
function rectangleScore(
  edges: { gx: Float32Array; gy: Float32Array },
  width: number,
  height: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): number {
  const sides: number[] = [];

  if (x0 > 0) {
    const side: number[] = [];
    for (let y = y0; y <= y1; y++) side.push(edges.gx[y * width + x0]!);
    sides.push(percentile(side, CONTINUITY_PERCENTILE));
  }
  if (x1 < width - 1) {
    const side: number[] = [];
    for (let y = y0; y <= y1; y++) side.push(edges.gx[y * width + x1]!);
    sides.push(percentile(side, CONTINUITY_PERCENTILE));
  }
  if (y0 > 0) {
    const side: number[] = [];
    for (let x = x0; x <= x1; x++) side.push(edges.gy[y0 * width + x]!);
    sides.push(percentile(side, CONTINUITY_PERCENTILE));
  }
  if (y1 < height - 1) {
    const side: number[] = [];
    for (let x = x0; x <= x1; x++) side.push(edges.gy[y1 * width + x]!);
    sides.push(percentile(side, CONTINUITY_PERCENTILE));
  }

  // Tutti e quattro i lati sul bordo del frame = il frame intero, non un overlay.
  if (sides.length === 0) return 0;
  return Math.min(...sides);
}

/** Posizioni candidate per un lato: i massimi locali del profilo dei contorni, dal più marcato. */
function borderCandidates(
  edges: Float32Array,
  width: number,
  axis: "column" | "row",
  bandStart: number,
  bandEnd: number,
  from: number,
  to: number,
): number[] {
  if (to - from < 2 || bandEnd - bandStart < 8) return [];

  const scores: number[] = [];
  for (let pos = from; pos <= to; pos++) {
    const along: number[] = [];
    for (let k = bandStart; k <= bandEnd; k++) {
      along.push(axis === "column" ? edges[k * width + pos]! : edges[pos * width + k]!);
    }
    scores.push(percentile(along, CONTINUITY_PERCENTILE));
  }

  const typical = median(scores);
  const threshold = Math.max(typical * CANDIDATE_STRENGTH_RATIO, 1e-6);

  const peaks: Array<{ pos: number; score: number }> = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i]! < threshold) continue;
    const windowStart = Math.max(0, i - LOCAL_MAX_WINDOW);
    const windowEnd = Math.min(scores.length - 1, i + LOCAL_MAX_WINDOW);
    let isLocalMax = true;
    for (let k = windowStart; k <= windowEnd; k++) {
      if (scores[k]! > scores[i]!) {
        isLocalMax = false;
        break;
      }
    }
    if (isLocalMax) peaks.push({ pos: from + i, score: scores[i]! });
  }

  return peaks
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES_PER_SIDE)
    .map((p) => p.pos);
}

/** Mappa dei contorni mediata nel tempo: gx = stacchi orizzontali (bordi verticali), gy = viceversa. */
async function buildPersistentEdgeMap(
  videoPath: string,
  sampleTimes: number[],
  width: number,
  height: number,
): Promise<{ gx: Float32Array; gy: Float32Array } | null> {
  const gx = new Float32Array(width * height);
  const gy = new Float32Array(width * height);
  let used = 0;

  for (const t of sampleTimes) {
    let frame: Buffer;
    try {
      frame = await extractRawFrameBGRScaled(videoPath, t, width, height);
    } catch {
      continue;
    }
    if (frame.length < width * height * 3) continue;

    const luma = toLuma(frame, width, height);
    for (let y = 1; y < height; y++) {
      for (let x = 1; x < width; x++) {
        const i = y * width + x;
        gx[i]! += Math.abs(luma[i]! - luma[i - 1]!);
        gy[i]! += Math.abs(luma[i]! - luma[i - width]!);
      }
    }
    used++;
  }

  if (used === 0) return null;
  for (let i = 0; i < gx.length; i++) {
    gx[i]! /= used;
    gy[i]! /= used;
  }
  return { gx, gy };
}

function implausibleReason(rect: CropWindow, face: FaceBox, sourceWidth: number, sourceHeight: number): string | null {
  const slackX = face.width * 0.6;
  const slackY = face.height * 0.6;
  const containsFace =
    face.x >= rect.x - slackX &&
    face.y >= rect.y - slackY &&
    face.x + face.width <= rect.x + rect.width + slackX &&
    face.y + face.height <= rect.y + rect.height + slackY;
  if (!containsFace) return "il rettangolo non contiene il volto";

  const areaRatio = (rect.width * rect.height) / (sourceWidth * sourceHeight);
  if (areaRatio < 0.005) return `troppo piccolo (${(areaRatio * 100).toFixed(1)}% del frame)`;
  if (areaRatio > 0.5) return `troppo grande (${(areaRatio * 100).toFixed(1)}% del frame)`;

  const aspect = rect.width / rect.height;
  if (aspect < 0.5 || aspect > 3) return `proporzioni non da webcam (${aspect.toFixed(2)})`;

  if (rect.width <= face.width || rect.height <= face.height) return "più stretto del volto";

  // Una webcam INQUADRA una persona: il volto occupa una fetta importante del riquadro (misurato
  // su webcam reali: 28-39% dell'altezza). Un volto dentro il contenuto reagito — la faccia in un
  // TikTok, dentro il player — è invece piccolo rispetto al rettangolo che lo contiene, perché
  // quel rettangolo è il player, non una webcam. È il segnale che distingue i due casi, che
  // altrimenti si somigliano: anche il player di un TikTok è un rettangolo fermo con bordi netti.
  const faceHeightRatio = face.height / rect.height;
  if (faceHeightRatio < MIN_FACE_TO_RECT_RATIO) {
    return `volto troppo piccolo nel riquadro (${(faceHeightRatio * 100).toFixed(0)}%): sembra contenuto, non una webcam`;
  }
  return null;
}

function toLuma(bgr: Buffer, width: number, height: number): Float32Array {
  const luma = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 3;
    luma[i] = 0.114 * bgr[o]! + 0.587 * bgr[o + 1]! + 0.299 * bgr[o + 2]!;
  }
  return luma;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[index]!;
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
