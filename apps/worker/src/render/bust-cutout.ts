import sharp from "sharp";
import { cutoutPerson } from "./birefnet.js";
import { detectFaces } from "../face-tracking/onnx-face-detector.js";

/**
 * Busto scontornato dalla foto (o fotogramma della webcam) di una persona: trova il volto più
 * grande, ritaglia testa, spalle e un po' di petto, lo ingrandisce e poi lo scontorna con BiRefNet.
 * Non sa chi è la persona: il nome lo dà sempre simo. null se non c'è nessun volto.
 */
export async function cutBustFromPhoto(photo: string | Buffer): Promise<Buffer | null> {
  const img = sharp(photo).rotate();
  const { width, height } = await img.metadata();
  if (!width || !height) return null;
  const rgb = await img.clone().resize(320, 240, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const bgr = Buffer.alloc(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    bgr[i] = rgb[i + 2]!;
    bgr[i + 1] = rgb[i + 1]!;
    bgr[i + 2] = rgb[i]!;
  }
  const faces = await detectFaces(bgr, width, height);
  const f = faces.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!f) return null;
  // Busto: testa, spalle e un po' di petto, come nelle copertine.
  const left = Math.max(0, Math.round(f.x - f.width * 1.1));
  const top = Math.max(0, Math.round(f.y - f.height * 0.6));
  const right = Math.min(width, Math.round(f.x + f.width * 2.1));
  const bottom = Math.min(height, Math.round(f.y + f.height * 2.8));
  // Risoluzione più alta PRIMA dello scontorno (richiesta di simo): ridimensionamento classico
  // lanczos, niente AI che reinventa i dettagli, così il viso resta identico; in più lo scontorno
  // lavora su più pixel e i bordi vengono più puliti.
  const cropH = bottom - top;
  const targetH = cropH < 1000 ? Math.min(1600, Math.max(1000, cropH * 2)) : cropH;
  const crop = await img
    .clone()
    .extract({ left, top, width: right - left, height: cropH })
    .resize({ height: targetH, kernel: "lanczos3" })
    .sharpen({ sigma: 0.8, m1: 0.5, m2: 1.5 })
    .png()
    .toBuffer();
  const scale = targetH / cropH;
  const cut = await cutoutPerson(crop, { x: (f.x + f.width / 2 - left) * scale, y: (f.y + f.height / 2 - top) * scale });
  return sharp(cut).trim().resize({ height: 800, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
}
