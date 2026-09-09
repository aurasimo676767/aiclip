import path from "node:path";
import { extractRawFrameBGR } from "../face-tracking/frame-extractor.js";
import { detectFaces } from "../face-tracking/onnx-face-detector.js";
import { detectWebcamRectDebug } from "../face-tracking/webcam-rect.js";
import { runFfmpeg } from "../lib/ffmpeg.js";

/**
 * Verifica visiva del rilevamento del riquadro webcam: rileva i volti in un punto della clip,
 * per ognuno cerca il rettangolo dell'overlay e DISEGNA il risultato sul fotogramma (verde =
 * riquadro trovato, rosso = volto per cui non è stato trovato).
 *
 * Uso: tsx src/dev/test-webcam-rect.ts <video> <width> <height> <start> <end> [out.png]
 */
const [videoPath, wArg, hArg, startArg, endArg, outArg] = process.argv.slice(2);
if (!videoPath || !wArg || !hArg || !startArg || !endArg) {
  throw new Error("Uso: tsx test-webcam-rect.ts <video> <width> <height> <start> <end> [out.png]");
}

const sourceWidth = Number(wArg);
const sourceHeight = Number(hArg);
const start = Number(startArg);
const end = Number(endArg);
const outPath = path.resolve(outArg ?? "webcam-rect.png");

// Fotogrammi distribuiti sulla clip: è la loro media a far emergere i bordi fermi (vedi webcam-rect.ts).
const SAMPLES = 10;
const sampleTimes = Array.from({ length: SAMPLES }, (_, i) => start + ((end - start) * (i + 0.5)) / SAMPLES);

const midpoint = (start + end) / 2;

// Volti raccolti su PIÙ fotogrammi e deduplicati per posizione: su un singolo fotogramma il
// detector spesso vede solo una delle webcam presenti (o solo un alert di passaggio).
const collected: Array<{ face: { x: number; y: number; width: number; height: number; score: number }; seen: number }> = [];
for (const t of sampleTimes) {
  const f = await extractRawFrameBGR(videoPath, t);
  for (const face of await detectFaces(f, sourceWidth, sourceHeight)) {
    const near = collected.find(
      (c) =>
        Math.hypot(c.face.x + c.face.width / 2 - (face.x + face.width / 2), c.face.y + c.face.height / 2 - (face.y + face.height / 2)) <
        Math.max(c.face.width, face.width),
    );
    if (near) near.seen++;
    else collected.push({ face, seen: 1 });
  }
}

// Stesso filtro di persistenza della pipeline (MIN_ANCHOR_SEGMENT_COVERAGE_RATIO): una webcam sta
// lì tutto il tempo, un alert di iscrizione compare per pochi secondi e NON deve essere trattato
// come webcam.
const MIN_COVERAGE = 0.4;
const faces = collected.filter((c) => c.seen / sampleTimes.length >= MIN_COVERAGE).map((c) => c.face);
const skipped = collected.length - faces.length;
console.log(
  `Volti persistenti (>=${MIN_COVERAGE * 100}% dei fotogrammi): ${faces.length}` +
    (skipped > 0 ? ` — ${skipped} scartati perché di passaggio (alert/contenuto)` : ""),
);

const boxes: string[] = [];
for (const face of faces) {
  const areaRatio = (face.width * face.height) / (sourceWidth * sourceHeight);
  const result = await detectWebcamRectDebug(videoPath, sampleTimes, face, sourceWidth, sourceHeight);
  console.log(
    `  volto x=${face.x.toFixed(0)} y=${face.y.toFixed(0)} w=${face.width.toFixed(0)} h=${face.height.toFixed(0)} ` +
      `(${(areaRatio * 100).toFixed(2)}% del frame) -> ${result.rect ? JSON.stringify(result.rect) : "NIENTE"} [${result.reason}]`,
  );
  for (const alt of result.alternatives) {
    const r = alt.rect;
    console.log(`      alt: ${r.width}x${r.height} @ ${r.x},${r.y}  aspetto ${(r.width / r.height).toFixed(2)}  punteggio ${alt.score.toFixed(1)}`);
  }

  boxes.push(`drawbox=x=${Math.round(face.x)}:y=${Math.round(face.y)}:w=${Math.round(face.width)}:h=${Math.round(face.height)}:color=red:t=3`);
  if (result.rect) {
    const r = result.rect;
    boxes.push(`drawbox=x=${r.x}:y=${r.y}:w=${r.width}:h=${r.height}:color=lime:t=6`);
  }
}

if (boxes.length === 0) {
  console.log("Nessun volto: niente da disegnare.");
} else {
  await runFfmpeg(["-y", "-ss", String(midpoint), "-i", videoPath, "-vf", boxes.join(","), "-frames:v", "1", outPath]);
  console.log("Immagine con i riquadri:", outPath);
}
