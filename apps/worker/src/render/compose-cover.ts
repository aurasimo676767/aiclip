import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";

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

  const slots = faceSlots(params.kind, params.faces.length).slice(0, params.faces.length);
  // Le facce laterali si disegnano prima, così la principale resta davanti.
  const order = slots.map((s, i) => ({ s, i })).sort((a, b) => a.s.z - b.s.z);
  for (const { s, i } of order) {
    const face = await styledFace(params.faces[i]!, Math.round(H * s.height), Math.round(W * s.maxWidth), { bgTone, glow: params.theme.fillBottom });
    const left = Math.round(W * s.centerX - face.width / 2);
    // Busti che salgono dal FONDO della copertina (richiesta di simo): il bordo basso della faccia
    // esce un filo sotto il canvas, mai una testa che galleggia a metà.
    const top = H - face.height + Math.round(H * s.sink);
    layers.push(...(await clampOverlay(face.buffer, face.width, face.height, left, top)));
  }

  if (params.kind === "reaction") {
    // Reaction: la scritta è "<STREAMER> REACTION", in basso a sinistra (le facce stanno a destra):
    // la copertina originale ha quasi sempre già un suo testo, un secondo titolo ci finirebbe sopra.
    layers.push({ input: cornerShade(), left: 0, top: 0 });
    const title = renderTitle(params.title.toUpperCase(), params.theme, 700);
    layers.push({ input: title.buffer, left: 10, top: H - title.height - 4 });
  } else {
    const title = renderTitle(params.title.toUpperCase(), params.theme, 1120);
    layers.push({ input: title.buffer, left: Math.round((W - title.width) / 2), top: H - title.height - 4 });
  }

  await sharp(background).composite(layers).jpeg({ quality: 92 }).toFile(params.outputPath);
}

interface FaceSlot {
  /** Centro orizzontale, frazione della larghezza. */
  centerX: number;
  /** Quanto il fondo del busto esce sotto il canvas (frazione dell'altezza). */
  sink: number;
  /** Altezza massima e larghezza massima, frazioni del canvas (vince la più stretta). */
  height: number;
  maxWidth: number;
  /** Ordine di disegno: più alto = più davanti. Chi sta dietro spunta dalla spalla di chi sta davanti. */
  z: number;
}

/**
 * Disposizione a strati presa dalle copertine studiate: i busti salgono dal fondo, quelli davanti
 * più grandi ai lati, quelli dietro un po' più piccoli e parzialmente coperti dalla spalla di chi
 * sta davanti. La scritta in basso copre i petti.
 */
function faceSlots(kind: "reaction" | "game", n: number): FaceSlot[] {
  if (kind === "reaction") {
    if (n <= 1) return [{ centerX: 0.8, sink: 0.04, height: 0.95, maxWidth: 0.48, z: 2 }];
    return [
      { centerX: 0.83, sink: 0.04, height: 0.93, maxWidth: 0.42, z: 2 },
      { centerX: 0.6, sink: 0.04, height: 0.8, maxWidth: 0.34, z: 1 },
    ].slice(0, n);
  }
  const layouts: Record<number, FaceSlot[]> = {
    1: [{ centerX: 0.74, sink: 0.04, height: 0.95, maxWidth: 0.5, z: 2 }],
    2: [
      { centerX: 0.26, sink: 0.04, height: 0.94, maxWidth: 0.46, z: 2 },
      { centerX: 0.72, sink: 0.04, height: 0.88, maxWidth: 0.44, z: 1 },
    ],
    3: [
      { centerX: 0.2, sink: 0.04, height: 0.92, maxWidth: 0.4, z: 2 },
      { centerX: 0.5, sink: 0.06, height: 0.78, maxWidth: 0.34, z: 1 },
      { centerX: 0.8, sink: 0.04, height: 0.92, maxWidth: 0.4, z: 2 },
    ],
    4: [
      { centerX: 0.17, sink: 0.04, height: 0.9, maxWidth: 0.34, z: 3 },
      { centerX: 0.39, sink: 0.06, height: 0.76, maxWidth: 0.3, z: 1 },
      { centerX: 0.61, sink: 0.06, height: 0.76, maxWidth: 0.3, z: 1 },
      { centerX: 0.83, sink: 0.04, height: 0.9, maxWidth: 0.34, z: 3 },
    ],
  };
  return layouts[Math.min(4, Math.max(1, n))]!;
}

/** Faccia ridimensionata con contorno bianco spesso e ombra morbida, come nelle copertine dei grafici. */
/**
 * Faccia pronta per la copertina: pulizia della trasparenza, sfumatura del fondo, color correction
 * (più contrasto, colore e nitidezza, tono tirato verso quello dello sfondo così non sembra
 * incollata), contorno bianco, bagliore del colore della scritta e ombra.
 */
async function styledFace(
  pngPath: string,
  maxHeight: number,
  maxWidth: number,
  look: { bgTone: { r: number; g: number; b: number }; glow: string },
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const resized = await sharp(pngPath).resize({ height: maxHeight, width: maxWidth, fit: "inside" }).ensureAlpha().png().toBuffer();
  const { width: fw, height: fh } = await sharp(resized).metadata();
  // Trasparenza pulita: lo scontorno lascia aloni quasi trasparenti (residui dello sfondo della
  // copertina di partenza) che il contorno bianco trasformava in chiazze. Si tiene solo il pieno,
  // con un filo di morbidezza sul bordo, e si sfuma il fondo così il taglio dritto delle spalle
  // sparisce, come fanno i grafici.
  const fade = Buffer.from(
    `<svg width="${fw}" height="${fh}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="84%" stop-color="#fff"/><stop offset="100%" stop-color="#000"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#f)"/></svg>`,
  );
  const fadeMask = await sharp(fade).greyscale().raw().toBuffer();
  const solid = await sharp(resized).extractChannel(3).threshold(120).blur(1.2).raw().toBuffer();
  const cleanAlpha = Buffer.alloc(solid.length);
  for (let i = 0; i < solid.length; i++) cleanAlpha[i] = Math.round((solid[i]! * fadeMask[i * (fadeMask.length / solid.length)]!) / 255);
  // Color correction: più contrasto e colore, nitidezza, poi un velo del tono dello sfondo in
  // "luce morbida" (12%) che lega la faccia alla scena senza cambiarle la pelle.
  const graded = await sharp(resized).removeAlpha().modulate({ saturation: 1.18, brightness: 1.03 }).linear(1.1, -8).sharpen({ sigma: 1.1 }).toBuffer();
  const toneLayer = await sharp({ create: { width: fw!, height: fh!, channels: 4, background: { ...look.bgTone, alpha: 0.12 } } }).png().toBuffer();
  const rgb = await sharp(graded).composite([{ input: toneLayer, blend: "soft-light" }]).removeAlpha().toBuffer();
  const face = await sharp(rgb)
    .joinChannel(await sharp(cleanAlpha, { raw: { width: fw!, height: fh!, channels: 1 } }).png().toBuffer())
    .png()
    .toBuffer();
  const targetHeight = fh!;
  const meta = { width: fw, height: fh };
  const stroke = Math.max(6, Math.round(targetHeight * 0.014));
  const pad = stroke * 3 + 16;
  const w = meta.width! + pad * 2;
  const h = meta.height! + pad * 2;
  const padded = await sharp(face).extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();

  const alpha = await sharp(padded).extractChannel(3).toBuffer();
  // Soglia alta: dove la faccia sfuma (fondo) il contorno non deve comparire, altrimenti resta un velo bianco.
  const outline = await sharp(alpha).blur(stroke * 0.8).threshold(90).toBuffer();
  const white = await sharp({ create: { width: w, height: h, channels: 3, background: "#ffffff" } }).joinChannel(outline).png().toBuffer();
  const shadowAlpha = await sharp(outline).blur(12).linear(0.55, 0).toBuffer();
  const shadow = await sharp({ create: { width: w, height: h, channels: 3, background: "#000000" } }).joinChannel(shadowAlpha).png().toBuffer();
  // Bagliore del colore della scritta attorno alla persona, come nelle copertine dei grafici.
  const glowAlpha = await sharp(outline).blur(Math.max(8, stroke * 2.2)).linear(0.7, 0).toBuffer();
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
  return { buffer, width: w, height: h };
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
