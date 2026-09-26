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
const TITLE_FONT = { file: "Anton-Regular.ttf", family: "Anton" };

export interface CoverTheme {
  /** Sfumatura del riempimento della scritta, dall'alto in basso. */
  fillTop: string;
  fillBottom: string;
  /** Colore della pennellata dietro l'ultima riga. */
  brush: string;
}

export const COVER_THEMES: Record<string, CoverTheme> = {
  giallo: { fillTop: "#fff200", fillBottom: "#ffae00", brush: "#e3141d" },
  bianco: { fillTop: "#ffffff", fillBottom: "#dfe6ee", brush: "#e3141d" },
  rosso: { fillTop: "#ff4b3e", fillBottom: "#d10f1a", brush: "#ffd400" },
  verde: { fillTop: "#c8ff4a", fillBottom: "#35c21f", brush: "#161616" },
  azzurro: { fillTop: "#7ff0ff", fillBottom: "#1a8dff", brush: "#e3141d" },
  rosa: { fillTop: "#ffb3e6", fillBottom: "#ff2f9a", brush: "#161616" },
  arancio: { fillTop: "#ffd000", fillBottom: "#ff6a00", brush: "#e3141d" },
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
    const size = faceSize(p.cutout.shape, p.slot);
    const face = await styledFace(p.cutout.png, size.height, size.width + 1, p.mirror, p.fade, {
      bgTone,
      glow: params.theme.fillBottom,
    });
    // Il margine trasparente (contorno e bagliore) sta FUORI dal canvas: la persona tocca il bordo
    // basso (o ci passa sotto, se il busto è lungo), e negli angoli tocca il bordo laterale col
    // lato tagliato.
    const top = size.top - face.pad;
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
    const title = renderTitle(params.title.toUpperCase(), params.theme, two ? 900 : 700);
    layers.push(...(await clampOverlay(title.buffer, title.width, title.height, two ? Math.round((W - title.width) / 2) : -30, H - title.height + 6)));
  } else {
    const title = renderTitle(params.title.toUpperCase(), params.theme, 1100);
    layers.push(...(await clampOverlay(title.buffer, title.width, title.height, Math.round((W - title.width) / 2), H - title.height + 6)));
  }

  await sharp(background).composite(layers).jpeg({ quality: 92 }).toFile(params.outputPath);
}

interface FaceSlot {
  /** "left"/"right": angolo, la persona tocca quel bordo. "free": centrata su centerX. */
  anchor: "left" | "right" | "free";
  centerX: number;
  /** Larghezza voluta della TESTA, frazione della larghezza del canvas: le facce devono essere enormi. */
  head: number;
  /** Dove sta la cima della testa, frazione dell'altezza (più alto = persona più in basso). */
  headTop: number;
  /** Larghezza massima della persona, frazione del canvas. */
  maxWidth: number;
  /** Ordine di disegno: più alto = più davanti. */
  z: number;
}

/**
 * Posti delle facce. Regole di simo: i busti partono ESATTAMENTE dal bordo basso; chi è tagliato su
 * un lato va in un angolo col lato tagliato contro il bordo (effetto "entra da fuori"), specchiato
 * se serve; nel mezzo della copertina non devono MAI vedersi tagli. Il protagonista (il primo) va
 * nell'angolo sinistro nei giochi e in quello destro nelle reaction (a sinistra resta il video
 * reagito).
 */
function slotsFor(kind: "reaction" | "game", n: number): FaceSlot[] {
  const left: FaceSlot = { anchor: "left", centerX: 0, head: 0.21, headTop: 0.05, maxWidth: 0.46, z: 3 };
  const right: FaceSlot = { anchor: "right", centerX: 1, head: 0.21, headTop: 0.05, maxWidth: 0.46, z: 3 };
  if (kind === "reaction") {
    // Il protagonista davanti a destra e più in basso (simo: "blur andrebbe messo più in basso").
    if (n <= 1) return [{ ...right, head: 0.24, headTop: 0.1, maxWidth: 0.5 }];
    return [
      { ...right, head: 0.22, headTop: 0.12 },
      { ...left, head: 0.2, headTop: 0.06, maxWidth: 0.42, z: 2 },
    ];
  }
  if (n <= 1) return [{ ...right, head: 0.24, maxWidth: 0.52 }];
  if (n === 2) return [left, right];
  const free = (centerX: number, maxWidth: number): FaceSlot => ({ anchor: "free", centerX, head: 0.15, headTop: 0.12, maxWidth, z: 1 });
  if (n === 3) return [left, right, free(0.5, 0.34)];
  return [left, right, free(0.38, 0.28), free(0.62, 0.28)];
}

/**
 * Misura della persona in copertina: la testa larga quanto chiede il posto; se così il busto non
 * arriva al bordo basso si ingrandisce finché ci arriva (i busti partono SEMPRE dal fondo); se
 * diventa troppo larga si riduce e la testa scende. La cima della testa sta a headTop, a meno che
 * il busto sia corto: allora appoggia sul fondo.
 */
function faceSize(shape: CutoutShape, slot: FaceSlot): { width: number; height: number; top: number } {
  const { width: cw, height: ch } = shape.box;
  let scale = (slot.head * W) / Math.max(1, shape.headWidth);
  scale = Math.max(scale, (H * (1 - slot.headTop)) / ch);
  scale = Math.min(scale, (slot.maxWidth * W) / cw);
  const width = Math.round(cw * scale);
  const height = Math.round(ch * scale);
  return { width, height, top: Math.max(Math.round(H * slot.headTop), H - height) };
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

function resvgOptions() {
  return { font: { fontFiles: [path.join(FONTS_DIR, TITLE_FONT.file)], loadSystemFonts: false, defaultFontFamily: TITLE_FONT.family } };
}

function renderSvg(svg: string): { buffer: Buffer; width: number; height: number } {
  const resvg = new Resvg(svg, resvgOptions());
  const img = resvg.render();
  return { buffer: img.asPng(), width: img.width, height: img.height };
}

/** Numeri pseudo-casuali ripetibili (stessa scritta = stessa pennellata). */
function seeded(text: string): () => number {
  let s = 2166136261;
  for (const c of text) s = Math.imul(s ^ c.charCodeAt(0), 16777619);
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822507);
    s = Math.imul(s ^ (s >>> 13), 3266489909);
    return ((s ^= s >>> 16) >>> 0) / 4294967296;
  };
}

/**
 * Pennellata dietro la scritta: una banda dai bordi sfrangiati, più lunga del testo, con qualche
 * striscia sottile che scappa ai lati (come le copertine che simo ha mandato come modello).
 */
function brushPath(x0: number, x1: number, cy: number, h: number, rand: () => number): string {
  const step = 18;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let x = x0; x <= x1; x += step) {
    // Più stretta verso le punte, come un colpo di pennello.
    const t = (x - x0) / (x1 - x0);
    const taper = Math.min(1, Math.min(t, 1 - t) * 6);
    const half = (h / 2) * (0.35 + 0.65 * taper);
    top.push(`${x.toFixed(1)},${(cy - half + (rand() - 0.5) * h * 0.18).toFixed(1)}`);
    bottom.unshift(`${x.toFixed(1)},${(cy + half + (rand() - 0.5) * h * 0.18).toFixed(1)}`);
  }
  let d = `M${top.join(" L")} L${bottom.join(" L")} Z`;
  for (let i = 0; i < 5; i++) {
    const y = cy + (rand() - 0.5) * h * 0.9;
    const th = h * (0.04 + rand() * 0.06);
    const left = rand() < 0.5;
    const len = (x1 - x0) * (0.12 + rand() * 0.18);
    const sx = left ? x0 - len * 0.35 : x1 + len * 0.35;
    const ex = left ? sx + len : sx - len;
    d += ` M${sx.toFixed(1)},${y.toFixed(1)} L${ex.toFixed(1)},${(y - th).toFixed(1)} L${ex.toFixed(1)},${(y + th).toFixed(1)} Z`;
  }
  return d;
}

/**
 * Scritta del titolo, nello stile del modello di simo ("DOPPIAGGIO DROGHEGGIANTE"): Anton
 * condensato e inclinato, prima riga bianca e l'ultima col colore del tema in sfumatura, contorno
 * nero spesso, ombra piena in basso a destra e una pennellata dietro. Sta DAVANTI alle facce.
 * La misura si adatta: si disegna, si misura l'ingombro vero e si riscala.
 */
function renderTitle(text: string, theme: CoverTheme, maxWidth: number): { buffer: Buffer; width: number; height: number } {
  const lines = splitLines(text);
  const draw = (fontSize: number, brushSpan: { x: number; width: number } | null) => {
    const lineHeight = fontSize * 0.9;
    const stroke = Math.round(fontSize * 0.1);
    const shadow = Math.round(fontSize * 0.06);
    const margin = Math.round(fontSize * 0.6);
    const width = maxWidth + margin * 2;
    const height = Math.round(lineHeight * lines.length + fontSize * 0.35 + margin);
    const baseline = (i: number) => margin * 0.5 + fontSize * 0.92 + i * lineHeight;
    const fillFor = (i: number) => (lines.length > 1 && i < lines.length - 1 ? "url(#w)" : "url(#g)");
    const texts = (fill: (i: number) => string, dx: number, dy: number, strokeWidth: number) =>
      lines
        .map(
          (l, i) =>
            `<text x="${width / 2 + dx}" y="${baseline(i) + dy}" text-anchor="middle" font-family="${TITLE_FONT.family}" font-size="${fontSize}" fill="${fill(i)}" stroke="#000" stroke-width="${strokeWidth}" stroke-linejoin="round" paint-order="stroke fill">${escapeXml(l)}</text>`,
        )
        .join("");
    const rand = seeded(text);
    // Pennellata a cavallo fra le ultime due righe, poco più larga del testo.
    const brushY = baseline(lines.length - 1) - fontSize * (lines.length > 1 ? 0.78 : 0.4);
    const bx = brushSpan ? brushSpan.x - brushSpan.width * 0.13 : 0;
    const bw = brushSpan ? brushSpan.width * 1.26 : 0;
    const brush = brushPath(bx, bx + bw, brushY, fontSize * 0.9, rand);
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="15%" stop-color="${theme.fillTop}"/><stop offset="100%" stop-color="${theme.fillBottom}"/></linearGradient>
        <linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#e9e9ee"/></linearGradient>
      </defs>
      <g transform="rotate(-2 ${width / 2} ${height / 2})">
        ${brushSpan ? `<path d="${brush}" fill="${theme.brush}"/>` : ""}
        <g transform="translate(${width / 2} 0) skewX(-7) scale(1.1 1) translate(${-width / 2} 0)">
          ${texts(() => "#000", shadow, shadow, stroke)}
          ${texts(fillFor, 0, 0, stroke)}
        </g>
      </g>
    </svg>`;
    return svg;
  };
  // Prima stima (Anton: circa 0,44 em, 0,48 allargato per lettera maiuscola), poi si corregge sull'ingombro vero.
  const longest = Math.max(...lines.map((l) => l.length));
  const cap = lines.length === 1 ? 180 : 150;
  let fontSize = Math.min(cap, Math.floor(maxWidth / (longest * 0.48)));
  let span = { x: 0, width: maxWidth };
  for (let i = 0; i < 4; i++) {
    // Si misura il solo testo: la pennellata sborda apposta.
    const bbox = new Resvg(draw(fontSize, null), resvgOptions()).getBBox();
    const textWidth = bbox ? bbox.width : maxWidth;
    span = { x: bbox ? bbox.x : 0, width: textWidth };
    if (Math.abs(textWidth - maxWidth) < maxWidth * 0.04) break;
    const next = Math.min(cap, Math.floor((fontSize * maxWidth) / textWidth));
    if (next === fontSize) break;
    fontSize = next;
  }
  const bbox = new Resvg(draw(fontSize, null), resvgOptions()).getBBox();
  if (bbox) span = { x: bbox.x, width: bbox.width };
  return renderSvg(draw(fontSize, span));
}
