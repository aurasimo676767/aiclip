import sharp from "sharp";
import { runFfmpegBinary } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";
import { scoreActiveSpeakers } from "./active-speaker.js";
import type { CropWindow } from "./face-tracker.js";
import { DETECTOR_INPUT_HEIGHT, DETECTOR_INPUT_WIDTH } from "./frame-extractor.js";
import { detectFaces, type FaceBox } from "./onnx-face-detector.js";
import { rejectionReasonForWebcamRect } from "./webcam-shape.js";
import { detectWebcamRectDebug } from "./webcam-rect.js";

/**
 * Webcam per i primi piani dei video lunghi (simo, 2026-10-26: zoom sulla persona sbagliata o su
 * mezzo gioco). Nelle live di gruppo le webcam sono 3-4 piccole agli angoli e chi gioca a Switch
 * Sports sta in piedi lontano: la faccia è alta 30-40 px su 1080, e il rilevatore che guarda il
 * fotogramma intero ridotto a 320x240 la vede di 6 px e la perde (in 4 secondi trovava 1 volto su 4).
 * Qui il fotogramma si guarda a tasselli sovrapposti. Le webcam si cercano attorno a OGNI primo piano
 * (fotogrammi nei secondi vicini): la live cambia layout da un gioco all'altro (nel bowling e nel
 * tennis di Switch Sports stavano in posti diversi), e mescolando layout diversi il riquadro di una
 * webcam non si trovava più. Poi si cerca la faccia DENTRO ciascuna webcam e il modello bocca+voce
 * dice chi parla.
 */

export interface StreamWebcam {
  rect: CropWindow;
  /** Dov'è di solito la faccia: serve se in quel momento il rilevatore non la trova. */
  face: FaceBox;
  /** Riquadro stimato dalla faccia (quello vero non si trovava): non è preciso, mai a schermo pieno. */
  estimated?: boolean;
}

/** Tasselli alti 1/3 del fotogramma, in 4:3 come l'ingresso del rilevatore, sovrapposti a metà: su 1080p 480x360 ridotti a 320x240, faccia 4 volte più grande che a fotogramma intero. */
const TILE_HEIGHT_FRACTION = 1 / 3;
/** Volti a meno di così (px sul sorgente 1080p) fra un fotogramma e l'altro sono la stessa webcam: chi gioca in piedi si sposta. */
const SAME_CAM_DISTANCE_PX = 160;
/** Una webcam vera c'è in buona parte dei momenti guardati (un volto dentro il gioco no). */
const MIN_PRESENCE_RATIO = 0.25;
/**
 * Volto senza un riquadro riconoscibile attorno (la webcam di Blur ha dietro una grafica a rombo, non
 * un bordo netto): vale come webcam solo se c'è quasi sempre (STEADY_PRESENCE_RATIO dei fotogrammi) e
 * sta vicino a un bordo (EDGE_ZONE_RATIO del lato), come gli inserti; i volti dei personaggi del gioco
 * stanno in mezzo e vanno e vengono. Il riquadro si stima dalla faccia: alto FACE_TO_CAM_HEIGHT volte
 * la faccia, fra CAM_MIN/MAX_HEIGHT_RATIO dell'altezza dello schermo.
 */
const STEADY_PRESENCE_RATIO = 0.75;
const EDGE_ZONE_RATIO = 0.22;
const FACE_TO_CAM_HEIGHT = 4.5;
const CAM_MIN_HEIGHT_RATIO = 0.18;
const CAM_MAX_HEIGHT_RATIO = 0.35;
/** Fotogrammi guardati per trovare le webcam, nei DISCOVERY_SPAN_SECONDS prima e dopo il primo piano. */
const DISCOVERY_FRAMES = 8;
const DISCOVERY_SPAN_SECONDS = 8;
/** Punteggio minimo del modello chi-parla (>0 = parla) per dare il primo piano: sotto, nel dubbio niente. */
const MIN_SPEAKING_SCORE = 0.5;
/**
 * Di quanto chi parla deve staccare il secondo (simo, 2026-11-05: "deve essere sicura l'IA di chi
 * zoomare"): con due facce quasi pari lo zoom poteva finire su chi stava zitto. Sotto, niente zoom.
 */
const MIN_SPEAKING_MARGIN = 0.6;
/**
 * Una webcam vera cambia sempre un po' fra un fotogramma e l'altro (la persona si muove, sbatte gli
 * occhi, la compressione); il ritratto di un personaggio nel gioco o un'immagine fissa no. Differenza
 * media (0-255) sul volto rimpicciolito sotto cui il volto è un'immagine ferma, non una persona.
 */
const STATIC_FACE_DIFF = 2;
const PATCH_SIZE = 24;

async function frameBGR(videoPath: string, at: number, width: number, height: number): Promise<Buffer> {
  return runFfmpegBinary(["-ss", String(Math.max(0, at)), "-i", videoPath, "-frames:v", "1", "-s", `${width}x${height}`, "-pix_fmt", "bgr24", "-f", "rawvideo", "-"]);
}

/** Volti in una zona del fotogramma (già in memoria a piena risoluzione), in coordinate del sorgente. */
async function facesIn(frame: Buffer, width: number, height: number, zone: CropWindow): Promise<FaceBox[]> {
  const left = Math.max(0, Math.round(zone.x));
  const top = Math.max(0, Math.round(zone.y));
  const w = Math.min(width - left, Math.round(zone.width));
  const h = Math.min(height - top, Math.round(zone.height));
  if (w < 16 || h < 16) return [];
  // sharp non sa che i byte sono BGR, ma ritagliare e ridimensionare non tocca l'ordine dei canali.
  const tile = await sharp(frame, { raw: { width, height, channels: 3 } })
    .extract({ left, top, width: w, height: h })
    .resize(DETECTOR_INPUT_WIDTH, DETECTOR_INPUT_HEIGHT, { fit: "fill" })
    .raw()
    .toBuffer();
  const faces = await detectFaces(tile, w, h);
  return faces.map((f) => ({ ...f, x: f.x + left, y: f.y + top }));
}

const center = (f: FaceBox) => ({ x: f.x + f.width / 2, y: f.y + f.height / 2 });
const distance = (a: FaceBox, b: FaceBox) => Math.hypot(center(a).x - center(b).x, center(a).y - center(b).y);

/** Tutti i volti del fotogramma, guardato a tasselli; i doppioni dei tasselli sovrapposti si fondono. */
async function facesInFrame(frame: Buffer, width: number, height: number): Promise<FaceBox[]> {
  const th = height * TILE_HEIGHT_FRACTION;
  const tw = Math.min(width, (th * 4) / 3);
  const found: FaceBox[] = [];
  for (let y = 0; y + th <= height + 1; y += th / 2) {
    for (let x = 0; x + tw <= width + 1; x += tw / 2) {
      for (const f of await facesIn(frame, width, height, { x, y, width: tw, height: th })) {
        const twin = found.findIndex((g) => distance(f, g) < Math.max(f.width, g.width) * 0.6);
        if (twin < 0) found.push(f);
        else if (f.score > found[twin]!.score) found[twin] = f;
      }
    }
  }
  return found;
}

/**
 * Le webcam della live guardando `times` (secondi del sorgente, tutti con lo stesso layout): volti
 * che tornano spesso nello stesso punto, col riquadro dell'overlay attorno e la forma di un inserto
 * (stessi controlli del pannello degli Shorts).
 */
export async function findStreamWebcams(videoPath: string, width: number, height: number, times: number[]): Promise<StreamWebcam[]> {
  const groups: Array<{ faces: FaceBox[]; times: Set<number>; patches: Buffer[] }> = [];
  for (const t of times) {
    let frame: Buffer;
    try {
      frame = await frameBGR(videoPath, t, width, height);
    } catch {
      continue;
    }
    for (const f of await facesInFrame(frame, width, height)) {
      const patch = await facePatch(frame, width, height, f).catch(() => null);
      const group = groups.find((g) => distance(g.faces[0]!, f) < SAME_CAM_DISTANCE_PX);
      if (group) {
        group.faces.push(f);
        group.times.add(t);
        if (patch) group.patches.push(patch);
      } else groups.push({ faces: [f], times: new Set([t]), patches: patch ? [patch] : [] });
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const cams: Array<StreamWebcam & { seen: number }> = [];
  for (const g of groups.filter((g) => g.times.size >= Math.max(2, times.length * MIN_PRESENCE_RATIO))) {
    const face: FaceBox = {
      x: median(g.faces.map((f) => f.x)),
      y: median(g.faces.map((f) => f.y)),
      width: median(g.faces.map((f) => f.width)),
      height: median(g.faces.map((f) => f.height)),
      score: median(g.faces.map((f) => f.score)),
    };
    // Un volto che resta identico in tutti i fotogrammi è un'immagine (personaggio del gioco, foto), non una webcam.
    const motion = maxPatchDiff(g.patches);
    if (g.patches.length >= 2 && motion < STATIC_FACE_DIFF) {
      logger.info("Primi piani: volto fermo scartato (immagine, non una persona)", { face: { x: Math.round(face.x), y: Math.round(face.y) }, movimento: motion.toFixed(2) });
      continue;
    }
    const samples = [...g.times].sort((a, b) => a - b);
    const picks = samples.length <= 10 ? samples : Array.from({ length: 10 }, (_, i) => samples[Math.round((i * (samples.length - 1)) / 9)]!);
    const found = await detectWebcamRectDebug(videoPath, picks, face, width, height);
    const reason = found.rect ? rejectionReasonForWebcamRect(found.rect, width, height) : "nessun riquadro attorno";
    let rect = found.rect;
    if (!rect || reason) {
      const steady = g.times.size >= times.length * STEADY_PRESENCE_RATIO;
      const c = center(face);
      const nearEdge = Math.min(c.x, width - c.x) <= width * EDGE_ZONE_RATIO || Math.min(c.y, height - c.y) <= height * EDGE_ZONE_RATIO;
      if (!steady || !nearEdge) {
        logger.info("Primi piani: volto scartato come webcam", { face: { x: Math.round(face.x), y: Math.round(face.y) }, motivo: reason });
        continue;
      }
      rect = camAroundFace(face, width, height);
    }
    const estimated = rect !== found.rect;
    // Due gruppi di volti dentro lo stesso riquadro (la persona si è spostata molto) sono una webcam sola.
    // Anche un riquadro stimato che si sovrappone a uno vero, o che contiene la stessa faccia: era la
    // stessa persona contata due volte (Mimic Party, 2026-11-06: "0,860=1.3" e "129,791=1.3"), e col
    // pareggio lo zoom non partiva mai.
    const same = cams.find(
      (c) => (Math.abs(c.rect.x - rect.x) < 12 && Math.abs(c.rect.y - rect.y) < 12) || overlapShare(c.rect, rect) > 0.4 || contains(c.rect, center(face)) || contains(rect, center(c.face)),
    );
    if (same) {
      // Vince il riquadro vero su quello stimato; a parità, la faccia vista più spesso.
      if ((same.estimated && !estimated) || (!!same.estimated === estimated && g.times.size > same.seen)) {
        Object.assign(same, { rect, face, seen: g.times.size });
        if (!estimated) delete same.estimated;
      }
      continue;
    }
    cams.push({ rect, face, seen: g.times.size, ...(estimated ? { estimated } : {}) });
  }
  logger.info("Primi piani: webcam trovate", {
    momentiGuardati: times.length,
    webcam: cams.map((c) => `${c.rect.x},${c.rect.y} ${c.rect.width}x${c.rect.height} (${c.seen})`),
  });
  return cams.map(({ seen: _seen, ...cam }) => cam);
}

/** Quota del riquadro più piccolo coperta dall'altro. */
function overlapShare(a: CropWindow, b: CropWindow): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.width * a.height, b.width * b.height);
}

const contains = (r: CropWindow, p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/** Il volto rimpicciolito in grigio, per capire se fra un fotogramma e l'altro cambia. */
async function facePatch(frame: Buffer, width: number, height: number, f: FaceBox): Promise<Buffer> {
  const left = Math.max(0, Math.round(f.x));
  const top = Math.max(0, Math.round(f.y));
  return sharp(frame, { raw: { width, height, channels: 3 } })
    .extract({ left, top, width: Math.max(8, Math.min(width - left, Math.round(f.width))), height: Math.max(8, Math.min(height - top, Math.round(f.height))) })
    .resize(PATCH_SIZE, PATCH_SIZE, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
}

/** La differenza media più grande fra il primo volto e gli altri (0-255). */
function maxPatchDiff(patches: Buffer[]): number {
  let max = 0;
  for (let k = 1; k < patches.length; k++) {
    let sum = 0;
    for (let i = 0; i < patches[0]!.length; i++) sum += Math.abs(patches[0]![i]! - patches[k]![i]!);
    max = Math.max(max, sum / patches[0]!.length);
  }
  return max;
}

/** Riquadro "da webcam" stimato attorno a una faccia, quando quello vero non si trova: 4:3, faccia nel terzo alto. */
function camAroundFace(face: FaceBox, width: number, height: number): CropWindow {
  const h = Math.min(height * CAM_MAX_HEIGHT_RATIO, Math.max(height * CAM_MIN_HEIGHT_RATIO, face.height * FACE_TO_CAM_HEIGHT));
  const w = (h * 4) / 3;
  const c = center(face);
  const x = Math.round(Math.min(width - w, Math.max(0, c.x - w / 2)));
  const y = Math.round(Math.min(height - h, Math.max(0, c.y - h * 0.35)));
  return { x, y, width: Math.round(w), height: Math.round(h) };
}

/**
 * Chi parla in un primo piano: le webcam di quel momento, la faccia cercata dentro ognuna (ingrandita) a
 * metà del primo piano, poi il modello bocca+voce dà un punteggio a ognuna e vince la più alta se parla
 * davvero. Niente preferenza per il proprietario: il primo piano è per chi reagisce. null = nessuno
 * parla chiaramente, o nessuna webcam.
 */
export async function findSpeakingWebcam(params: {
  videoPath: string;
  width: number;
  height: number;
  /** Finestra analizzata (secondi del sorgente): il modello ha bisogno di un po' di contesto. */
  from: number;
  to: number;
  /** Il primo piano vero e proprio, dentro la finestra. */
  focusFrom: number;
  focusTo: number;
}): Promise<StreamWebcam | null> {
  const { videoPath, width, height } = params;
  const span = { from: Math.max(0, params.focusFrom - DISCOVERY_SPAN_SECONDS), to: params.focusTo + DISCOVERY_SPAN_SECONDS };
  const times = Array.from({ length: DISCOVERY_FRAMES }, (_, i) => span.from + ((span.to - span.from) * (i + 0.5)) / DISCOVERY_FRAMES);
  const cams = await findStreamWebcams(videoPath, width, height, times);
  if (cams.length === 0) return null;
  const frame = await frameBGR(videoPath, (params.focusFrom + params.focusTo) / 2, width, height);
  const faces: FaceBox[] = [];
  const visible: boolean[] = [];
  for (const cam of cams) {
    const inCam = (await facesIn(frame, width, height, cam.rect)).sort((a, b) => b.width * b.height - a.width * a.height);
    faces.push(inCam[0] ?? cam.face);
    visible.push(!!inCam[0]);
  }
  const { scores, fps } = await scoreActiveSpeakers(videoPath, params.from, params.to - params.from, faces, width, height);
  const a = Math.max(0, Math.floor((params.focusFrom - params.from) * fps));
  const b = Math.max(a + 1, Math.ceil((params.focusTo - params.from) * fps));
  const means = scores.map((s) => {
    const part = s.slice(a, b);
    return part.length > 0 ? part.reduce((sum, v) => sum + v, 0) / part.length : -Infinity;
  });
  const best = means.indexOf(Math.max(...means));
  const second = Math.max(-Infinity, ...means.filter((_, k) => k !== best));
  // Zoom solo se è sicuro: parla davvero, stacca gli altri, e la sua faccia in quel momento si vede.
  const ok = best >= 0 && means[best]! >= MIN_SPEAKING_SCORE && means[best]! - second >= MIN_SPEAKING_MARGIN && visible[best] === true;
  logger.info("Primo piano: chi parla", {
    a: params.focusFrom.toFixed(1),
    webcam: cams.map((c, k) => `${c.rect.x},${c.rect.y}=${means[k]!.toFixed(1)}`),
    scelta: ok ? `${cams[best]!.rect.x},${cams[best]!.rect.y}` : "nessuno",
  });
  return ok ? cams[best]! : null;
}
