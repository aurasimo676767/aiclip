import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { CAPTION_FONTS } from "@clipforge/shared";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { CAPTION_FONTS_DIR, subtitlesFilter } from "../render/captions.js";

/**
 * Misura quanto è alta una "H" scritta da libass (sottotitoli ASS, Fontsize 100) e da un motore SVG/CSS
 * (font-size 100px = em) per ogni font dei sottotitoli: il rapporto serve all'anteprima del sito per
 * disegnare le parole della stessa misura del video (vedi CAPTION_FONTS.cssScale). Gratis, in locale.
 * Uso: tsx src/dev/measure-caption-fonts.ts
 */
const dir = path.resolve("tmp", "font-measure");
fs.mkdirSync(dir, { recursive: true });

async function inkHeight(png: string): Promise<number> {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x]! > 128) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }
  return bottom - top + 1;
}

for (const [id, font] of Object.entries(CAPTION_FONTS)) {
  const ass = path.join(dir, `${id}.ass`);
  fs.writeFileSync(
    ass,
    `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: D,${font.ass},100,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,${font.assBold ? -1 : 0},0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:05.00,D,,0,0,0,,{\\pos(540,960)}HHH\n`,
  );
  const assPng = path.join(dir, `${id}-ass.png`);
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:d=1", "-vf", subtitlesFilter(ass), "-frames:v", "1", assPng]);
  const fontFile = font.file ? path.join(CAPTION_FONTS_DIR, font.file) : "C:/Windows/Fonts/arialbd.ttf";
  const family = font.file ? font.ass.replace(" Black", "") : "Arial";
  const svg = `<svg width="1080" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#000"/><text x="100" y="250" font-family="${family}" font-size="100" font-weight="${font.weight}" fill="#fff">HHH</text></svg>`;
  const svgPng = path.join(dir, `${id}-svg.png`);
  fs.writeFileSync(svgPng, new Resvg(svg, { font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: family } }).render().asPng());
  const a = await inkHeight(assPng);
  const b = await inkHeight(svgPng);
  console.log(`${id}: H libass ${a}px, H css ${b}px -> cssScale ${(a / b).toFixed(3)}`);
}
