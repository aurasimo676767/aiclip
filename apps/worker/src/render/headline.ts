import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { logger } from "../lib/logger.js";

/**
 * Titolo fisso in alto negli Shorts, come immagine (PNG trasparente) da sovrapporre al video con
 * un'animazione d'entrata (vedi build-video-filter.ts). Chiesto da simo il 2026-09-27: metà di chi
 * vedeva gli Shorts scorreva via al primo secondo, e i canali che sfondano mettono un titolo corto
 * e grosso che dice subito di cosa si parla. Richieste: corto, che non sembri AI, bel font, emoji,
 * animazione. I sottotitoli ASS non sanno disegnare emoji a colori, per questo è un'immagine:
 * testo col font delle copertine (Anton) + emoji Twemoji vere.
 */

const FONTS_DIR = path.resolve(process.cwd(), "assets", "fonts");
const FONT = { file: "Anton-Regular.ttf", family: "Anton" };
const EMOJI_CACHE = path.resolve(process.cwd(), "assets", "emoji-cache");
const MAX_WIDTH = 960;
const BASE_SIZE = 118;
const LINE_HEIGHT = 1.02;
const STROKE = 14;

const EMOJI_RE = /\p{Extended_Pictographic}(?:\u{FE0F}|\u{200D}\p{Extended_Pictographic}|\p{Emoji_Modifier})*/gu;

function resvgOptions() {
  return { font: { fontFiles: [path.join(FONTS_DIR, FONT.file)], loadSystemFonts: false, defaultFontFamily: FONT.family } };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Emoji Twemoji a colori (PNG 72x72) in cache locale; null se non si trova. */
async function emojiPng(emoji: string): Promise<Buffer | null> {
  const codes = [...emoji].map((c) => c.codePointAt(0)!.toString(16)).filter((c) => c !== "fe0f");
  const name = codes.join("-");
  const local = path.join(EMOJI_CACHE, `${name}.png`);
  try {
    return await fsp.readFile(local);
  } catch {
    // non in cache
  }
  try {
    const res = await fetch(`https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/${name}.png`);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.mkdir(EMOJI_CACHE, { recursive: true });
    await fsp.writeFile(local, buf);
    return buf;
  } catch {
    return null;
  }
}

/** Divide in al massimo due righe equilibrate; le emoji vanno in fondo alla riga in cui stavano. */
function splitLines(words: string[]): string[][] {
  const len = (ws: string[]) => ws.join(" ").length;
  if (words.length <= 1 || len(words) <= 14) return [words];
  let best = { diff: Infinity, i: 1 };
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(len(words.slice(0, i)) - len(words.slice(i)));
    if (diff < best.diff) best = { diff, i };
  }
  return [words.slice(0, best.i), words.slice(best.i)];
}

function textWidth(text: string, size: number): number {
  const svg = `<svg width="4000" height="${size * 2}" xmlns="http://www.w3.org/2000/svg"><text x="0" y="${size}" font-family="${FONT.family}" font-size="${size}" stroke="#000" stroke-width="${STROKE}">${escapeXml(text)}</text></svg>`;
  const bbox = new Resvg(svg, resvgOptions()).getBBox();
  return bbox ? bbox.width : text.length * size * 0.45;
}

/**
 * Crea il PNG del titolo. Ritorna le sue misure, o null se il testo è vuoto. Prima riga bianca,
 * seconda (o unica) gialla, contorno nero spesso e ombra, leggermente inclinato come le copertine.
 */
export async function renderHeadlinePng(text: string, outputPath: string): Promise<{ width: number; height: number } | null> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const emojis = clean.match(EMOJI_RE) ?? [];
  const words = clean
    .replace(EMOJI_RE, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
  if (words.length === 0) return null;
  const lines = splitLines(words).map((ws) => ws.join(" "));

  let size = BASE_SIZE;
  const emojiSlot = (s: number) => (emojis.length > 0 ? emojis.length * s * 0.95 + s * 0.15 : 0);
  // Si rimpicciolisce finché la riga più lunga (con le emoji in fondo all'ultima) sta nella larghezza.
  for (let i = 0; i < 6; i++) {
    const widest = Math.max(...lines.map((l, k) => textWidth(l, size) + (k === lines.length - 1 ? emojiSlot(size) : 0)));
    if (widest <= MAX_WIDTH) break;
    size = Math.floor((size * MAX_WIDTH) / widest);
  }

  const pad = STROKE * 2 + 16;
  const lineH = Math.round(size * LINE_HEIGHT);
  const widths = lines.map((l, k) => textWidth(l, size) + (k === lines.length - 1 ? emojiSlot(size) : 0));
  const width = Math.ceil(Math.max(...widths) + pad * 2);
  const height = Math.ceil(lineH * lines.length + size * 0.25 + pad * 2);

  const emojiImages = await Promise.all(emojis.map(emojiPng));
  const parts: string[] = [];
  lines.forEach((line, k) => {
    const baseline = pad + size * 0.92 + k * lineH;
    const lineWidth = widths[k]!;
    const x0 = (width - lineWidth) / 2;
    const fill = lines.length > 1 && k === 0 ? "url(#w)" : "url(#y)";
    const text = `<text x="${x0}" y="${baseline}" font-family="${FONT.family}" font-size="${size}" fill="${fill}" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round" paint-order="stroke fill">${escapeXml(line)}</text>`;
    const shadow = `<text x="${x0 + 6}" y="${baseline + 8}" font-family="${FONT.family}" font-size="${size}" fill="#000" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round" opacity="0.55">${escapeXml(line)}</text>`;
    parts.push(shadow, text);
    if (k === lines.length - 1) {
      let ex = x0 + textWidth(line, size) + size * 0.15;
      emojiImages.forEach((img) => {
        if (!img) return;
        parts.push(`<image x="${ex}" y="${baseline - size * 0.82}" width="${size * 0.9}" height="${size * 0.9}" href="data:image/png;base64,${img.toString("base64")}"/>`);
        ex += size * 0.95;
      });
    }
  });

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#e6e6ec"/></linearGradient>
      <linearGradient id="y" x1="0" y1="0" x2="0" y2="1"><stop offset="10%" stop-color="#fff200"/><stop offset="100%" stop-color="#ffae00"/></linearGradient>
    </defs>
    <g transform="translate(${width / 2} 0) skewX(-6) translate(${-width / 2} 0)">${parts.join("")}</g>
  </svg>`;
  try {
    const png = new Resvg(svg, resvgOptions()).render().asPng();
    await sharp(png).png().toFile(outputPath);
    return { width, height };
  } catch (err) {
    logger.warn("Titolo fisso non creato", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
