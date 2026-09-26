import path from "node:path";
import sharp from "sharp";
import * as ort from "onnxruntime-node";
import { logger } from "../lib/logger.js";

/**
 * Scontorno delle persone con BiRefNet (modello "portrait", licenza MIT, ~930 MB, scaricato a parte da
 * https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-portrait-epoch_150.onnx
 * in apps/worker/models: vedi .gitignore). Molto più preciso del modello "medium" di imgly su
 * capelli, cuffie, mani e bordi: con quello simo aveva scartato l'85% dei ritagli ("ritagliate
 * MALISSIMO"). Restituisce un PNG con trasparenza morbida ai bordi (i capelli restano naturali).
 */

const MODEL_PATH = path.resolve(process.cwd(), "models", "BiRefNet-portrait-epoch_150.onnx");
const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  sessionPromise ??= (async () => {
    // Prima la scheda video (DirectML su Windows), altrimenti il processore: è solo più lento.
    try {
      const s = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["dml", "cpu"] });
      logger.info("BiRefNet caricato", { provider: "dml/cpu" });
      return s;
    } catch (error) {
      logger.warn("BiRefNet senza scheda video, uso il processore", { error: error instanceof Error ? error.message : String(error) });
      return ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["cpu"] });
    }
  })();
  return sessionPromise;
}

/** Maschera della persona (0-255, stessa dimensione dell'immagine) calcolata da BiRefNet. */
async function personMask(image: Buffer, width: number, height: number): Promise<Buffer> {
  const rgb = await sharp(image).removeAlpha().resize(SIZE, SIZE, { fit: "fill" }).raw().toBuffer();
  const plane = SIZE * SIZE;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) data[c * plane + i] = (rgb[i * 3 + c]! / 255 - MEAN[c]!) / STD[c]!;
  }
  const input = new ort.Tensor("float32", data, [1, 3, SIZE, SIZE]);
  let session = await getSession();
  let output: ort.InferenceSession.OnnxValueMapType;
  try {
    output = await session.run({ [session.inputNames[0]!]: input });
  } catch (error) {
    // La scheda video (8 GB) può non bastare, soprattutto con Whisper già caricato: si passa al
    // processore per il resto della sessione (più lento, ma con 32 GB di RAM ci sta sempre).
    logger.warn("BiRefNet: scheda video senza memoria, passo al processore", { error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
    sessionPromise = ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["cpu"] });
    session = await sessionPromise;
    output = await session.run({ [session.inputNames[0]!]: input });
  }
  // L'ultima uscita è la maschera a piena risoluzione (in logit): sigmoide -> 0..255.
  const logits = output[session.outputNames[session.outputNames.length - 1]!]!.data as Float32Array;
  const mask = Buffer.alloc(plane);
  for (let i = 0; i < plane; i++) mask[i] = Math.round(255 / (1 + Math.exp(-logits[i]!)));
  // extractChannel(0): sharp restituisce 3 canali dopo resize/threshold anche partendo da 1, e letta
  // come 1 canale la maschera usciva sfasata (righe e trasparenza ovunque).
  return sharp(mask, { raw: { width: SIZE, height: SIZE, channels: 1 } }).resize(width, height, { fit: "fill", kernel: "lanczos3" }).extractChannel(0).raw().toBuffer();
}

/**
 * Scontorna la persona: PNG con trasparenza. Toglie anche il contorno bianco che i grafici mettono
 * attorno alle facce nelle copertine (pixel quasi bianchi nella fascia del bordo della maschera),
 * altrimenti resterebbe attaccato al ritaglio.
 */
export async function cutoutPerson(image: Buffer, keepPoint?: { x: number; y: number }): Promise<Buffer> {
  const { width, height } = await sharp(image).metadata();
  if (!width || !height) throw new Error("Immagine senza dimensioni");
  const mask = await personMask(image, width, height);
  // Nucleo: la maschera "ristretta" di qualche pixel. La fascia fra nucleo e bordo è dove stanno i
  // contorni dei grafici.
  const band = Math.max(3, Math.round(Math.min(width, height) * 0.012));
  const core = await sharp(mask, { raw: { width, height, channels: 1 } }).blur(band).threshold(235).extractChannel(0).raw().toBuffer();
  const rgb = await sharp(image).removeAlpha().raw().toBuffer();
  for (let i = 0; i < width * height; i++) {
    if (mask[i]! < 8 || core[i]! > 0) continue;
    const r = rgb[i * 3]!;
    const g = rgb[i * 3 + 1]!;
    const b = rgb[i * 3 + 2]!;
    const nearWhite = r > 215 && g > 215 && b > 215 && Math.max(r, g, b) - Math.min(r, g, b) < 28;
    if (nearWhite) mask[i] = 0;
  }
  if (keepPoint) keepOnlyComponentAt(mask, width, height, keepPoint);
  const alpha = await sharp(mask, { raw: { width, height, channels: 1 } }).png().toBuffer();
  return sharp(rgb, { raw: { width, height, channels: 3 } }).joinChannel(alpha).png().toBuffer();
}

/**
 * Tiene solo la "macchia" della maschera che contiene il punto dato (il centro della faccia trovata):
 * un'altra persona vicina o pezzi di grafica NON attaccati alla persona spariscono. Se il punto
 * cade fuori dalla maschera si parte dal pixel di maschera più vicino.
 */
function keepOnlyComponentAt(mask: Buffer, width: number, height: number, point: { x: number; y: number }): void {
  const on = (i: number) => mask[i]! > 60;
  let start = -1;
  const px = Math.min(width - 1, Math.max(0, Math.round(point.x)));
  const py = Math.min(height - 1, Math.max(0, Math.round(point.y)));
  for (let r = 0; r < Math.max(width, height) && start < 0; r += 2) {
    for (let dy = -r; dy <= r && start < 0; dy += Math.max(1, r)) {
      for (let dx = -r; dx <= r; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x >= 0 && y >= 0 && x < width && y < height && on(y * width + x)) {
          start = y * width + x;
          break;
        }
      }
    }
  }
  if (start < 0) return;
  const keep = new Uint8Array(width * height);
  const stack = [start];
  keep[start] = 1;
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % width;
    const neighbors = [i - width, i + width, x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1];
    for (const n of neighbors) {
      if (n >= 0 && n < mask.length && !keep[n] && on(n)) {
        keep[n] = 1;
        stack.push(n);
      }
    }
  }
  // Si allarga la macchia di 2 pixel così la sfumatura del bordo (capelli) resta, poi via il resto.
  for (let pass = 0; pass < 2; pass++) {
    const grown = keep.slice();
    for (let i = 0; i < keep.length; i++) {
      if (keep[i]) continue;
      const x = i % width;
      if ((i >= width && keep[i - width]) || (i + width < keep.length && keep[i + width]) || (x > 0 && keep[i - 1]) || (x < width - 1 && keep[i + 1])) grown[i] = 1;
    }
    keep.set(grown);
  }
  for (let i = 0; i < mask.length; i++) if (!keep[i]) mask[i] = 0;
}
