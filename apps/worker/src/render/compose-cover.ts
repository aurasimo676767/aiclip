import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { measureCutout, type CutoutShape } from "../lib/face-library.js";

/**
 * Copertina long-form nello stile dei canali di clip su Blur/Marza/Pesh (studiati il 2026-09-25):
 * sfondo vero e saturo (la copertina ORIGINALE per le reaction, un fotogramma del gioco VERO per i
 * giochi), facce scontornate grandi davanti con contorno bianco e ombra, 1-3 parole enormi in basso
 * con bordo nero ed effetto 3D, e per le reaction l'etichetta "REACTION" in alto a sinistra.
 * Le facce sono SEMPRE persone vere a cui simo ha dato un nome: questo modulo non ne sceglie.
 */

const W = 1280;
const H = 720;
const FONTS_DIR = path.resolve(process.cwd(), "assets", "fonts");
const TITLE_FONT = { file: "LuckiestGuy-Regular.ttf", family: "Luckiest Guy" };

export interface CoverTheme {
  /** Sfumatura del riempimento della scritta, dall'alto in basso. */
  fillTop: string;
  fillBottom: string;
}

export const COVER_THEMES: Record<string, CoverTheme> = {
  giallo: { fillTop: "#fff27a", fillBottom: "#ffb800" },
  bianco: { fillTop: "#ffffff", fillBottom: "#dfe6ee" },
  rosso: { fillTop: "#ff6b5e", fillBottom: "#e0141f" },
  verde: { fillTop: "#b6ff6b", fillBottom: "#2fc12f" },
  azzurro: { fillTop: "#8ff3ff", fillBottom: "#1a9dff" },
  rosa: { fillTop: "#ffb3e6", fillBottom: "#ff3fa4" },
  arancio: { fillTop: "#ffd36b", fillBottom: "#ff6a00" },
};

export interface ComposeCoverParams {
  backgroundPath: string;
  kind: "reaction" | "game";
  /** PNG scontornati, il più importante per primo (2-4 per i giochi, 1-2 per le reaction). */
  faces: string[];
  /** 1-3 parole, verranno messe in maiuscolo. */
  title: string;
  theme: CoverTheme;
  outputPath: string;
}

export async function composeCover(params: ComposeCoverParams): Promise<void> {
  const background = await sharp(params.backgroundPath)
    .resize(W, H, { fit: "cover", position: "attention" })
    .modulate({ saturation: 1.3, brightness: 1.04 })
    .linear(1.1, -10)
    .toBuffer();

  const stats = await sharp(background).resize(64, 36).stats();
  const bgTone = { r: Math.round(stats.channels[0]!.mean), g: Math.round(stats.channels[1]!.mean), b: Math.round(stats.channels[2]!.mean) };
  const layers: sharp.OverlayOptions[] = [{ input: vignette(), left: 0, top: 0 }];

  const placed = await placeFaces(params.kind, params.faces);
  // Chi sta dietro si disegna prima, così il protagonista resta davanti.
  for (const p of [...placed].sort((a, b) => a.slot.z - b.slot.z)) {
    const face = await styledFace(p.cutout.png, Math.round(H * p.slot.height), Math.round(W * p.slot.maxWidth), p.mirror, p.fade, {
      bgTone,
      glow: params.theme.fillBottom,
    });
    // Il margine trasparente (contorno e bagliore) sta FUORI dal canvas: la persona tocca il bordo
    // basso esattamente, e negli angoli tocca il bordo laterale col lato tagliato. "sink" la
    // abbassa ancora: il fondo del busto esce dal canvas e la testa scende.
    const top = H - face.height + face.pad + Math.round(H * (p.slot.sink ?? 0));
    const left =
      p.slot.anchor === "left" ? -face.pad : p.slot.anchor === "right" ? W - face.width + face.pad : Math.round(W * p.slot.centerX - face.width / 2);
    layers.push(...(await clampOverlay(face.buffer, face.width, face.height, left, top)));
  }

  if (params.kind === "reaction") {
    // Reaction: "<STREAMER> REACTION". Con una sola faccia (a destra) la scritta sta in basso a
    // sinistra sopra un'ombra che copre il testo della copertina originale; con due facce (negli
    // angoli) sta al centro fra le due.
    const two = placed.length >= 2;
    if (!two) layers.push({ input: cornerShade(), left: 0, top: 0 });
    const title = renderTitle(params.title.toUpperCase(), params.theme, two ? 640 : 700);
    layers.push({ input: title.buffer, left: two ? Math.round((W - title.width) / 2) : 10, top: H - title.height - 4 });
  } else {
    const title = renderTitle(params.title.toUpperCase(), params.theme, 1120);
    layers.push({ input: title.buffer, left: Math.round((W - title.width) / 2), top: H - title.height - 4 });
  }

  await sharp(background).composite(layers).jpeg({ quality: 92 }).toFile(params.outputPath);
}

interface FaceSlot {
  /** "left"/"right": angolo, la persona tocca quel bordo. "free": centrata su centerX. */
  anchor: "left" | "right" | "free";
  centerX: number;
  /** Altezza e larghezza massime, frazioni del canvas (vince la più stretta). */
  height: number;
  maxWidth: number;
  /** Ordine di disegno: più alto = più davanti. */
  z: number;
  /** Quanto scende sotto il bordo basso, frazione dell'altezza del canvas. */
  sink?: number;
}

/**
 * Posti delle facce. Regole di simo: i busti partono ESATTAMENTE dal bordo basso; chi è tagliato su
 * un lato va in un angolo col lato tagliato contro il bordo (effetto "entra da fuori"), specchiato
 * se serve; nel mezzo della copertina non devono MAI vedersi tagli. Il protagonista (il primo) va
 * nell'angolo sinistro nei giochi e in quello destro nelle reaction (a sinistra resta il video
 * reagito).
 */
function slotsFor(kind: "reaction" | "game", n: number): FaceSlot[] {
  const left: FaceSlot = { anchor: "left", centerX: 0, height: 0.94, maxWidth: 0.46, z: 3 };
  const right: FaceSlot = { anchor: "right", centerX: 1, height: 0.94, maxWidth: 0.46, z: 3 };
  if (kind === "reaction") {
    if (n <= 1) return [{ ...right, height: 1, maxWidth: 0.5, sink: 0.08 }];
    return [
      { ...right, height: 1, maxWidth: 0.46, sink: 0.1 },
      { ...left, height: 0.92, maxWidth: 0.42, z: 2, sink: 0.03 },
    ];
  }
  if (n <= 1) return [{ ...right, height: 0.97, maxWidth: 0.52 }];
  if (n === 2) return [left, right];
  if (n === 3) return [left, right, { anchor: "free", centerX: 0.5, height: 0.8, maxWidth: 0.34, z: 1 }];
  return [
    left,
    right,
    { anchor: "free", centerX: 0.38, height: 0.78, maxWidth: 0.28, z: 1 },
    { anchor: "free", centerX: 0.62, height: 0.78, maxWidth: 0.28, z: 1 },
  ];
}

interface Cutout {
  png: Buffer;
  shape: CutoutShape;
}

/**
 * Persona ritagliata stretta (via le righe e colonne vuote attorno), così il fondo del busto è il
 * fondo dell'immagine e in copertina parte ESATTAMENTE dal bordo basso.
 */
async function tightCutout(pngPath: string): Promise<Cutout> {
  const source = await fs.readFile(pngPath);
  const shape = await measureCutout(source);
  const png = await sharp(source).ensureAlpha().extract(shape.box).png().toBuffer();
  return { png, shape };
}

interface PlacedFace {
  cutout: Cutout;
  slot: FaceSlot;
  mirror: boolean;
  /** Lato (già specchiato) che resterebbe tagliato in mezzo alla copertina: si sfuma. */
  fade: "left" | "right" | null;
}

/**
 * Assegna le facce ai posti (vedi slotsFor). Negli angoli prima chi è tagliato di lato, col taglio
 * contro il bordo (specchiato se serve); in mezzo solo facce SENZA tagli laterali, altrimenti quel
 * posto resta vuoto. Chi è tagliato su entrambi i lati va comunque in un angolo (il taglio più lungo
 * contro il bordo) e il lato interno si sfuma: pickFaces le evita quando ci sono alternative.
 */
async function placeFaces(kind: "reaction" | "game", paths: string[]): Promise<PlacedFace[]> {
  const faces = (await Promise.all(paths.map(async (path, order) => ({ order, cutout: await tightCutout(path) })))).filter(
    (f) => !f.cutout.shape.cuts.top,
  );
  const slots = slotsFor(kind, faces.length);
  const cornerSlots = slots.filter((s) => s.anchor !== "free");
  const isCut = (f: (typeof faces)[number]) => f.cutout.shape.cuts.left || f.cutout.shape.cuts.right;
  // Nelle reaction il protagonista prende sempre il primo angolo; nei giochi gli angoli vanno prima
  // a chi è tagliato (in mezzo non potrebbe stare), nell'ordine del titolo.
  const cornerQueue = kind === "reaction" ? [...faces] : [...faces.filter(isCut), ...faces.filter((f) => !isCut(f))];
  const placed: PlacedFace[] = [];
  const used = new Set<number>();
  for (const slot of cornerSlots) {
    const f = cornerQueue.find((c) => !used.has(c.order));
    if (!f) break;
    used.add(f.order);
    const { leftCover, rightCover } = f.cutout.shape;
    const { left, right } = f.cutout.shape.cuts;
    // Il lato tagliato (il più lungo se sono due) deve guardare il bordo dell'angolo.
    const cutSide = left && right ? (leftCover >= rightCover ? "left" : "right") : left ? "left" : right ? "right" : null;
    const mirror = cutSide !== null && cutSide !== slot.anchor;
    const fade = left && right ? (slot.anchor === "left" ? "right" : "left") : null;
    placed.push({ cutout: f.cutout, slot, mirror, fade });
  }
  for (const slot of slots.filter((s) => s.anchor === "free")) {
    const f = faces.find((c) => !used.has(c.order) && !isCut(c));
    if (!f) continue;
    used.add(f.order);
    placed.push({ cutout: f.cutout, slot, mirror: false, fade: null });
  }
  return placed;
}

/**
 * Faccia pronta per la copertina: pulizia della trasparenza, color correction (più contrasto,
 * colore e nitidezza, tono tirato verso quello dello sfondo così non sembra incollata), contorno
 * bianco, bagliore del colore della scritta e ombra. Nessuna sfumatura sul fondo: il busto tocca il
 * bordo della copertina. Restituisce anche il margine trasparente aggiunto attorno (pad), che in
 * copertina va messo fuori dal canvas.
 */
async function styledFace(
  png: Buffer,
  maxHeight: number,
  maxWidth: number,
  mirror: boolean,
  fade: "left" | "right" | null,
  look: { bgTone: { r: number; g: number; b: number }; glow: string },
): Promise<{ buffer: Buffer; width: number; height: number; pad: number }> {
  let base = sharp(png).resize({ height: maxHeight, width: maxWidth, fit: "inside" }).ensureAlpha();
  if (mirror) base = base.flop();
  // Tutto in raw con i canali contati a mano: passando per PNG intermedi sharp a volte teneva
  // l'alpha della color correction e la trasparenza finiva sul nero di barba e capelli.
  const { data: rgba, info } = await base.raw().toBuffer({ resolveWithObject: true });
  const fw = info.width;
  const fh = info.height;
  const n = fw * fh;
  const rgbRaw = Buffer.alloc(n * 3);
  const alphaRaw = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    rgbRaw[i * 3] = rgba[i * 4]!;
    rgbRaw[i * 3 + 1] = rgba[i * 4 + 1]!;
    rgbRaw[i * 3 + 2] = rgba[i * 4 + 2]!;
    alphaRaw[i] = rgba[i * 4 + 3]!;
  }
  // Trasparenza pulita: via gli aloni quasi trasparenti (residui dello sfondo di partenza) che il
  // contorno bianco trasformava in chiazze; resta il pieno con un filo di morbidezza sul bordo.
  const cleanAlpha = await sharp(alphaRaw, { raw: { width: fw, height: fh, channels: 1 } })
    .threshold(120)
    .blur(1.2)
    .extractChannel(0)
    .raw()
    .toBuffer();
  // Color correction: più contrasto e colore, nitidezza, poi un velo del tono dello sfondo in
  // "luce morbida" (12%) che lega la faccia alla scena senza cambiarle la pelle.
  const graded = await sharp(rgbRaw, { raw: { width: fw, height: fh, channels: 3 } })
    .modulate({ saturation: 1.18, brightness: 1.03 })
    .linear(1.1, -8)
    .sharpen({ sigma: 1.1 })
    .png()
    .toBuffer();
  const toneLayer = await sharp({ create: { width: fw, height: fh, channels: 4, background: { ...look.bgTone, alpha: 0.12 } } }).png().toBuffer();
  const toned = await sharp(graded).composite([{ input: toneLayer, blend: "soft-light" }]).png().toBuffer();
  const { data: tonedRaw, info: tonedInfo } = await sharp(toned).raw().toBuffer({ resolveWithObject: true });
  const faceRaw = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    faceRaw[i * 4] = tonedRaw[i * tonedInfo.channels]!;
    faceRaw[i * 4 + 1] = tonedRaw[i * tonedInfo.channels + 1]!;
    faceRaw[i * 4 + 2] = tonedRaw[i * tonedInfo.channels + 2]!;
    faceRaw[i * 4 + 3] = cleanAlpha[i]!;
  }
  const stroke = Math.max(6, Math.round(fh * 0.014));
  const pad = stroke * 3 + 16;
  const w = fw + pad * 2;
  const h = fh + pad * 2;
  const padded = await sharp(faceRaw, { raw: { width: fw, height: fh, channels: 4 } })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const alpha = await sharp(padded).extractChannel(3).png().toBuffer();
  const outline = await sharp(alpha).blur(stroke * 0.8).threshold(90).extractChannel(0).png().toBuffer();
  const white = await sharp({ create: { width: w, height: h, channels: 3, background: "#ffffff" } }).joinChannel(outline).png().toBuffer();
  const shadowAlpha = await sharp(outline).blur(12).linear(0.55, 0).extractChannel(0).png().toBuffer();
  const shadow = await sharp({ create: { width: w, height: h, channels: 3, background: "#000000" } }).joinChannel(shadowAlpha).png().toBuffer();
  // Bagliore del colore della scritta attorno alla persona, come nelle copertine dei grafici.
  const glowAlpha = await sharp(outline).blur(Math.max(8, stroke * 2.2)).linear(0.7, 0).extractChannel(0).png().toBuffer();
  const glow = await sharp({ create: { width: w, height: h, channels: 3, background: look.glow } }).joinChannel(glowAlpha).png().toBuffer();

  const buffer = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: glow, left: 0, top: 0 },
      { input: white, left: 0, top: 0 },
      { input: padded, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
  if (!fade) return { buffer, width: w, height: h, pad };
  // Lato tagliato che resterebbe in mezzo alla copertina: sfuma tutto (persona, contorno, ombra e
  // bagliore) nell'ultimo 22% della larghezza, così non resta nessuna riga dura.
  const { data: out } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const span = Math.round(fw * 0.22);
  for (let x = 0; x < w; x++) {
    const d = fade === "left" ? x - pad : pad + fw - 1 - x;
    const k = d <= 0 ? 0 : d >= span ? 1 : d / span;
    if (k === 1) continue;
    for (let y = 0; y < h; y++) out[(y * w + x) * 4 + 3] = Math.round(out[(y * w + x) * 4 + 3]! * k * k);
  }
  return { buffer: await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(), width: w, height: h, pad };
}

/** sharp rifiuta sovrapposizioni che escono dal canvas: si ritaglia la parte fuori. */
async function clampOverlay(buffer: Buffer, width: number, height: number, left: number, top: number): Promise<sharp.OverlayOptions[]> {
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(W, left + width);
  const y1 = Math.min(H, top + height);
  if (x1 <= x0 || y1 <= y0) return [];
  if (x0 === left && y0 === top && x1 === left + width && y1 === top + height) return [{ input: buffer, left, top }];
  return [
    {
      input: await sharp(buffer).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }).png().toBuffer(),
      left: x0,
      top: y0,
    },
  ];
}

/** Ombra nell'angolo in basso a sinistra: sotto "BLUR REACTION" la scritta originale della copertina non deve leggersi. */
function cornerShade(): Buffer {
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="c" cx="0%" cy="100%" r="95%"><stop offset="0%" stop-color="#000" stop-opacity="0.95"/><stop offset="45%" stop-color="#000" stop-opacity="0.8"/><stop offset="80%" stop-color="#000" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`;
  return Buffer.from(svg);
}

function vignette(): Buffer {
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="v" cx="50%" cy="45%" r="75%"><stop offset="55%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.55"/></radialGradient><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.45"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#v)"/><rect width="100%" height="100%" fill="url(#b)"/></svg>`;
  return Buffer.from(svg);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Divide in al massimo 2 righe, bilanciate. */
function splitLines(text: string): string[] {
  const words = text.trim().split(/\s+/);
  if (words.length <= 1 || text.length <= 12) return [text];
  let best = [text];
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = [a, b];
    }
  }
  return best;
}

function renderSvg(svg: string): { buffer: Buffer; width: number; height: number } {
  const resvg = new Resvg(svg, {
    font: { fontFiles: [path.join(FONTS_DIR, TITLE_FONT.file)], loadSystemFonts: false, defaultFontFamily: TITLE_FONT.family },
  });
  const img = resvg.render();
  return { buffer: img.asPng(), width: img.width, height: img.height };
}

/**
 * Scritta del titolo: riempimento a sfumatura, bordo nero spesso, blocco "3D" scuro sotto (tante
 * copie scalate verso il basso), leggera rotazione. La misura si adatta alla riga più lunga.
 */
function renderTitle(text: string, theme: CoverTheme, maxWidth: number): { buffer: Buffer; width: number; height: number } {
  const lines = splitLines(text);
  const longest = Math.max(...lines.map((l) => l.length));
  // Luckiest Guy: circa 0.62 em per carattere in maiuscolo.
  const fontSize = Math.min(150, Math.floor(maxWidth / (longest * 0.62)), lines.length === 1 ? 170 : 130);
  const lineHeight = fontSize * 0.98;
  const depth = Math.round(fontSize * 0.07);
  const stroke = Math.round(fontSize * 0.13);
  const width = maxWidth + stroke * 2;
  const height = Math.round(lineHeight * lines.length + depth + stroke * 2 + fontSize * 0.15);

  const texts = (fill: string, dy: number, strokeColor: string, strokeWidth: number) =>
    lines
      .map(
        (l, i) =>
          `<text x="${width / 2}" y="${stroke + fontSize * 0.86 + i * lineHeight + dy}" text-anchor="middle" font-family="${TITLE_FONT.family}" font-size="${fontSize}" fill="${fill}" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linejoin="round" paint-order="stroke fill">${escapeXml(l)}</text>`,
      )
      .join("");

  const extrude = Array.from({ length: depth }, (_, k) => texts("#000", depth - k, "#000", stroke)).join("");
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${theme.fillTop}"/><stop offset="100%" stop-color="${theme.fillBottom}"/></linearGradient></defs>
    <g transform="rotate(-3 ${width / 2} ${height / 2})">${extrude}${texts("url(#g)", 0, "#000", stroke)}</g>
  </svg>`;
  return renderSvg(svg);
}
