import path from "node:path";
import * as ort from "onnxruntime-node";
import { DETECTOR_INPUT_HEIGHT, DETECTOR_INPUT_WIDTH } from "./frame-extractor.js";

// Risolto da process.cwd(), non da import.meta.url: in dev (tsx) il file sorgente è annidato
// in src/face-tracking, in produzione esbuild lo bundla in un unico dist/index.js — le due
// profondità di __dirname sono diverse, ma il worker viene sempre avviato con cwd = apps/worker
// (vedi anche il caricamento di .env), quindi è il riferimento stabile da usare qui.
const MODEL_PATH = path.resolve(process.cwd(), "models", "ultraface-RFB-320.onnx");

const SCORE_THRESHOLD = 0.75;
const IOU_THRESHOLD = 0.4;

export interface FaceBox {
  /** Coordinate in pixel, riferite alle dimensioni del frame ORIGINALE (non ai 320x240 del modello). */
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

interface RawDetection {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  sessionPromise ??= ort.InferenceSession.create(MODEL_PATH);
  return sessionPromise;
}

/**
 * Rileva i volti in un frame (buffer raw BGR24 320x240, vedi frame-extractor.ts) usando
 * Ultra-Light-Fast-Generic-Face-Detector (ONNX, ~1.2MB, nessuna dipendenza nativa da
 * compilare — a differenza di face-api.js/tfjs-node che richiedono `canvas`).
 * Ritorna i bounding box in coordinate pixel del frame ORIGINALE (sourceWidth/sourceHeight).
 */
export async function detectFaces(bgrBuffer: Buffer, sourceWidth: number, sourceHeight: number): Promise<FaceBox[]> {
  const session = await getSession();

  const planeSize = DETECTOR_INPUT_WIDTH * DETECTOR_INPUT_HEIGHT;
  const expectedBytes = planeSize * 3;
  if (bgrBuffer.length !== expectedBytes) {
    throw new Error(`Frame per face detection di dimensione inattesa: ${bgrBuffer.length} byte, attesi ${expectedBytes}`);
  }

  const floatData = new Float32Array(3 * planeSize);
  for (let i = 0; i < planeSize; i++) {
    const b = bgrBuffer[i * 3] ?? 0;
    const g = bgrBuffer[i * 3 + 1] ?? 0;
    const r = bgrBuffer[i * 3 + 2] ?? 0;
    floatData[i] = (b - 127) / 128;
    floatData[planeSize + i] = (g - 127) / 128;
    floatData[2 * planeSize + i] = (r - 127) / 128;
  }

  const inputTensor = new ort.Tensor("float32", floatData, [1, 3, DETECTOR_INPUT_HEIGHT, DETECTOR_INPUT_WIDTH]);
  const output = await session.run({ input: inputTensor });

  const scores = output.scores?.data as Float32Array | undefined;
  const boxes = output.boxes?.data as Float32Array | undefined;
  const numBoxes = output.scores?.dims[1] ?? 0;
  if (!scores || !boxes) {
    throw new Error("Output del modello di face detection mancante (scores/boxes)");
  }

  const detections: RawDetection[] = [];
  for (let i = 0; i < numBoxes; i++) {
    const faceScore = scores[i * 2 + 1] ?? 0;
    if (faceScore < SCORE_THRESHOLD) continue;
    detections.push({
      x1: boxes[i * 4] ?? 0,
      y1: boxes[i * 4 + 1] ?? 0,
      x2: boxes[i * 4 + 2] ?? 0,
      y2: boxes[i * 4 + 3] ?? 0,
      score: faceScore,
    });
  }

  return nonMaxSuppression(detections, IOU_THRESHOLD)
    .map((d) => {
      const x1 = Math.max(0, Math.min(1, d.x1));
      const y1 = Math.max(0, Math.min(1, d.y1));
      const x2 = Math.max(0, Math.min(1, d.x2));
      const y2 = Math.max(0, Math.min(1, d.y2));
      return {
        x: x1 * sourceWidth,
        y: y1 * sourceHeight,
        width: (x2 - x1) * sourceWidth,
        height: (y2 - y1) * sourceHeight,
        score: d.score,
      };
    })
    .filter((box) => box.width > 1 && box.height > 1);
}

function iou(a: RawDetection, b: RawDetection): number {
  const interX1 = Math.max(a.x1, b.x1);
  const interY1 = Math.max(a.y1, b.y1);
  const interX2 = Math.min(a.x2, b.x2);
  const interY2 = Math.min(a.y2, b.y2);
  const interArea = Math.max(0, interX2 - interX1) * Math.max(0, interY2 - interY1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - interArea;
  return union > 0 ? interArea / union : 0;
}

function nonMaxSuppression(detections: RawDetection[], iouThreshold: number): RawDetection[] {
  const remaining = [...detections].sort((a, b) => b.score - a.score);
  const kept: RawDetection[] = [];

  while (remaining.length > 0) {
    const best = remaining.shift();
    if (!best) break;
    kept.push(best);
    for (let i = remaining.length - 1; i >= 0; i--) {
      const candidate = remaining[i];
      if (candidate && iou(best, candidate) > iouThreshold) {
        remaining.splice(i, 1);
      }
    }
  }

  return kept;
}
