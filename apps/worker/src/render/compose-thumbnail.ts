import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;

const FONT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../assets/fonts/Anton-Regular.ttf");

// Stima grezza (Anton è un font bold molto condensato) — verificata a occhio sui render reali,
// non è una metrica esatta ma basta per decidere quando andare a capo.
const AVG_CHAR_WIDTH_RATIO = 0.62;

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Word-wrap grezzo su un numero massimo di righe, spezzando alla parola più vicina al punto medio. */
function wrapText(text: string, fontSize: number, maxWidthPx: number, maxLines: number): string[] {
  const maxChars = Math.max(4, Math.floor(maxWidthPx / (fontSize * AVG_CHAR_WIDTH_RATIO)));
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) {
        // ultima riga consentita: ci butta dentro tutto il resto, anche se sborda un po'
        const restIndex = words.indexOf(word);
        current = words.slice(restIndex).join(" ");
        break;
      }
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

interface StrokedTextOptions {
  text: string;
  fontSize: number;
  maxWidthPx: number;
  maxLines: number;
  fill: string;
  strokeColor: string;
  strokeWidth: number;
}

/** Renderizza testo con contorno spesso (stile titolo YouTube) su un PNG trasparente dimensionato al contenuto. */
function renderStrokedText(options: StrokedTextOptions): { buffer: Buffer; width: number; height: number } {
  const lines = wrapText(options.text, options.fontSize, options.maxWidthPx, options.maxLines);
  const lineHeight = options.fontSize * 1.15;
  const padding = options.strokeWidth * 2;
  const width = Math.round(options.maxWidthPx + padding * 2);
  const height = Math.round(lineHeight * lines.length + padding * 2);

  const tspans = lines
    .map((line, i) => {
      const y = padding + options.fontSize + i * lineHeight;
      return `<tspan x="${padding}" y="${y}" fill="${options.fill}">${escapeXml(line)}</tspan>`;
    })
    .join("");

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text font-family="Anton" font-size="${options.fontSize}" stroke="${options.strokeColor}" stroke-width="${options.strokeWidth}" paint-order="stroke fill" stroke-linejoin="round">${tspans}</text>
  </svg>`;

  const resvg = new Resvg(svg, {
    font: { fontFiles: [FONT_PATH], loadSystemFonts: false, defaultFontFamily: "Anton" },
  });
  const rendered = resvg.render();
  return { buffer: rendered.asPng(), width, height };
}

export interface ComposeThumbnailParams {
  /** Fotogramma scelto come sfondo (jpg/png locale). */
  backgroundFramePath: string;
  /** Ritaglio con sfondo rimosso (png con alpha) della faccia, o null se non disponibile in questo video. */
  faceCutoutPngPath: string | null;
  /** Es. "BLUR REACTION" o "BLUR GIOCA A GTA 6". */
  bannerText: string;
  outputPath: string;
}

/**
 * Compone la copertina finale: sfondo (fotogramma del video) + eventuale ritaglio della faccia
 * (ancorato in basso a destra) + banner in alto a sinistra. Layout FISSO (non deciso dall'IA):
 * più prevedibile e consistente di una posizione calcolata ogni volta, e un template ben tarato
 * regge la maggior parte dei fotogrammi di sfondo.
 */
export async function composeThumbnail(params: ComposeThumbnailParams): Promise<void> {
  const hasFace = Boolean(params.faceCutoutPngPath);
  // Se c'è la faccia a destra, il banner resta nella metà sinistra per non sovrapporsi.
  const textMaxWidth = hasFace ? 760 : 1180;

  const background = await sharp(params.backgroundFramePath)
    .resize(CANVAS_WIDTH, CANVAS_HEIGHT, { fit: "cover", position: "centre" })
    .jpeg()
    .toBuffer();

  const composite: sharp.OverlayOptions[] = [];

  if (params.faceCutoutPngPath) {
    // Il PNG del ritaglio spesso ha un margine trasparente attorno alla persona (non tagliato a
    // filo dal passaggio di rimozione sfondo) — .trim() lo toglie, altrimenti quel margine resta
    // come spazio vuoto anche dopo aver ancorato l'immagine all'angolo del canvas.
    const trimmedBuffer = await sharp(params.faceCutoutPngPath).trim().toBuffer();
    const faceMeta = await sharp(trimmedBuffer).metadata();
    const faceWidth = faceMeta.width || 1;
    const faceHeight = faceMeta.height || 1;
    // Vincola sia altezza che larghezza massime (non solo l'altezza): un ritaglio molto largo
    // (es. inquadratura a mezzo busto) altrimenti finisce per dominare metà del canvas.
    const maxHeight = CANVAS_HEIGHT * 0.95;
    const maxWidth = CANVAS_WIDTH * 0.5;
    const scale = Math.min(maxHeight / faceHeight, maxWidth / faceWidth);
    const targetWidth = Math.round(faceWidth * scale);
    const targetHeight = Math.round(faceHeight * scale);
    const faceResized = await sharp(trimmedBuffer).resize(targetWidth, targetHeight, { fit: "contain" }).png().toBuffer();
    composite.push({ input: faceResized, left: CANVAS_WIDTH - targetWidth, top: CANVAS_HEIGHT - targetHeight });
  }

  const banner = renderStrokedText({
    text: params.bannerText,
    fontSize: 72,
    maxWidthPx: textMaxWidth,
    maxLines: 2,
    fill: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 9,
  });
  composite.push({ input: banner.buffer, left: 40, top: 30 });

  await sharp(background).composite(composite).jpeg({ quality: 90 }).toFile(params.outputPath);
}
