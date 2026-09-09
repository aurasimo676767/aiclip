import type { FaceBox } from "./onnx-face-detector.js";

/**
 * Stima quanto si muove la bocca di un volto tra due frame ravvicinati (~150ms), come proxy
 * di "sta parlando adesso". Usato per scegliere QUALE webcam mettere in primo piano quando
 * ce ne sono più di una sempre visibili insieme: la sola presenza/stabilità (vedi
 * reaction-cam-face-tracker.ts) non basta a distinguere chi sta effettivamente parlando da
 * chi sta solo ascoltando in un dato momento.
 *
 * Nessun modello ML: differenza media di pixel (in BGR grezzo) nella metà inferiore del
 * bounding box del volto tra i due frame. Semplice ma efficace per questo scopo — un volto
 * fermo (in ascolto) ha differenza quasi nulla, uno che parla no.
 *
 * La risoluzione dei due frame la sceglie il chiamante (`frameWidth`/`frameHeight`) e conta
 * moltissimo: misurata sui 320x240 della face detection, la bocca di una webcam piccola era larga
 * pochi pixel e il valore risultava puro rumore — verificato su una clip con 4 webcam, la stessa
 * persona passava da 4 a 43 tra un segmento e l'altro e il pannello non cambiava mai speaker.
 */
export function computeMouthMotion(
  frameA: Buffer,
  frameB: Buffer,
  box: FaceBox,
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number,
): number {
  const scaleX = frameWidth / sourceWidth;
  const scaleY = frameHeight / sourceHeight;

  const bx = box.x * scaleX;
  const by = box.y * scaleY;
  const bw = box.width * scaleX;
  const bh = box.height * scaleY;

  // Regione bocca: metà inferiore del volto, un po' più stretta orizzontalmente (evita occhi/fronte).
  const x0 = clamp(Math.round(bx + bw * 0.2), 0, frameWidth - 1);
  const y0 = clamp(Math.round(by + bh * 0.55), 0, frameHeight - 1);
  const x1 = clamp(Math.round(bx + bw * 0.8), 0, frameWidth);
  const y1 = clamp(Math.round(by + bh * 0.9), 0, frameHeight);

  if (x1 <= x0 || y1 <= y0) return 0;
  if (frameA.length < frameWidth * frameHeight * 3 || frameB.length !== frameA.length) return 0;

  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * frameWidth + x) * 3;
      const diff = Math.abs((frameA[idx] ?? 0) - (frameB[idx] ?? 0)) + Math.abs((frameA[idx + 1] ?? 0) - (frameB[idx + 1] ?? 0)) + Math.abs((frameA[idx + 2] ?? 0) - (frameB[idx + 2] ?? 0));
      sum += diff;
      count++;
    }
  }

  return count > 0 ? sum / count : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
