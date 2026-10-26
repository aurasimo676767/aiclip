import {
  CAPTION_FONTS,
  LOWER_THIRD_Y,
  OUTPUT_RESOLUTION,
  buildCaptionCues,
  cueLayout,
  type CaptionCue,
  type CaptionSettings,
  type CaptionTrack,
  type TranscriptSegment,
} from "@clipforge/shared";
import type { Layout } from "../face-tracking/face-tracker.js";
import { escapeAssText, formatAssTime, shoutLevels, spokenWords } from "./captions.js";

/**
 * Sottotitoli di uno Short nello stile scelto dall'editor (vedi CaptionSettings in
 * packages/shared). Cosa compare e quando lo decide buildCaptionCues, condiviso con l'anteprima del
 * sito; qui si traduce in ASS per bruciarlo nel video. Lo stile "Classico" deve dare lo stesso
 * risultato dei sottotitoli di prima (pop a schiaffo, rosso sulle urla, giallo sulle parole chiave).
 */

/** Le parole dello Short coi tempi del video finale, per l'anteprima del sito e per rifare i sottotitoli. */
export function buildCaptionTrack(params: {
  segments: TranscriptSegment[];
  highlightWords: Set<string>;
  layout: Layout;
  duration: number;
  headline: string | null;
}): CaptionTrack {
  const words = spokenWords(params.segments);
  const levels = shoutLevels(words);
  return {
    version: 1,
    duration: params.duration,
    words: words.map((w) => ({
      text: w.word.trim(),
      start: round(w.start),
      end: round(w.end),
      loud: levels.get(w) ?? 0,
      key: params.highlightWords.has(normalizeWord(w.word)),
    })),
    anchors: layoutAnchors(params.layout, params.duration),
    headline: params.headline,
  };
}

const round = (t: number) => Math.round(t * 1000) / 1000;
const normalizeWord = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

/**
 * Dove stanno i sottotitoli "auto", tratto per tratto: sulla giunzione fra webcam e gioco nello
 * split (leggibile, non copre né il volto né il gioco), nel terzo basso sui primi piani e sul frame
 * intero (sotto il volto / sullo sfondo sfocato sotto il video).
 */
function layoutAnchors(layout: Layout, duration: number): CaptionTrack["anchors"] {
  if (layout.type === "split_vertical") return [{ start: 0, end: duration, y: layout.topRatio }];
  const anchors = layout.scenes.map((s) => ({
    start: round(s.startSeconds),
    end: round(s.endSeconds),
    y: s.composition.kind === "split" ? s.composition.topRatio : LOWER_THIRD_Y,
  }));
  return anchors.length ? anchors : [{ start: 0, end: duration, y: LOWER_THIRD_Y }];
}

/** #RRGGBB (+ opacità 0-1) nel formato colore ASS &HAABBGGRR (alpha 00 = opaco). */
function assColor(hex: string, opacity = 1): string {
  const clean = hex.replace("#", "");
  const alpha = Math.round((1 - opacity) * 255)
    .toString(16)
    .padStart(2, "0");
  return `&H${alpha}${clean.slice(4, 6)}${clean.slice(2, 4)}${clean.slice(0, 2)}`.toUpperCase();
}

export function buildStyledAss(track: CaptionTrack, settings: CaptionSettings): string {
  const font = CAPTION_FONTS[settings.font];
  const box = settings.box;
  // Riquadro: BorderStyle 3 disegna un rettangolo pieno del colore del contorno, largo quanto il
  // contorno attorno al testo (verificato a mano su libass: con 4 il testo teneva anche il contorno).
  const borderStyle = box ? 3 : 1;
  const outlineColour = box ? assColor(box.color, box.opacity) : assColor(settings.strokeColor);
  const outline = box ? Math.round(settings.size * 0.16) : settings.strokeWidth;
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${OUTPUT_RESOLUTION.width}
PlayResY: ${OUTPUT_RESOLUTION.height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font.ass},${settings.size},${assColor(settings.textColor)},${assColor(settings.textColor)},${outlineColour},&H80000000,${font.assBold ? -1 : 0},0,0,0,100,100,1,0,${borderStyle},${outline},${box ? 0 : settings.shadow},5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const cues = buildCaptionCues(track, settings);
  const events: string[] = [];
  cues.forEach((cue) => {
    const text = cueText(cue, settings);
    const pos = `\\an5\\pos(${Math.round(OUTPUT_RESOLUTION.width / 2)},${Math.round(OUTPUT_RESOLUTION.height * cue.y)})`;
    const { scaleX, scaleY } = cueLayout(cue.words, settings);
    const motion = cueMotion(cue, settings, scaleX * 100, scaleY * 100);
    const times = `${formatAssTime(cue.start)},${formatAssTime(cue.end)}`;
    // Bagliore: sotto, lo stesso testo con un contorno largo e sfocato del colore del contorno.
    if (settings.glow > 0 && !box) {
      const glow = `\\bord${settings.strokeWidth + settings.glow * 2}\\blur${settings.glow * 2}\\shad0`;
      // Sul livello del bagliore niente sfocatura d'entrata: sostituirebbe quella del bagliore.
      events.push(`Dialogue: 0,${times},Default,,0,0,0,,{${pos}${glow}${motion.replace(/\\blur\d+/g, "")}}${text}`);
      events.push(`Dialogue: 1,${times},Default,,0,0,0,,{${pos}\\blur1${motion}}${text}`);
    } else {
      events.push(`Dialogue: 0,${times},Default,,0,0,0,,{${pos}${motion}}${text}`);
    }
  });
  return `${header}\n${events.join("\n")}\n`;
}

/** Il testo della riga con il colore di ogni parola (la parola detta in activeColor) e gli a capo. */
function cueText(cue: CaptionCue, settings: CaptionSettings): string {
  const { lines } = cueLayout(cue.words, settings);
  return lines
    .map((line) =>
      line
        .map((i) => {
          const w = cue.words[i]!;
          const color = cue.activeIndex === i && settings.activeColor ? settings.activeColor : w.color;
          return `{\\c${assColor(color)}}${escapeAssText(w.text)}`;
        })
        .join(" "),
    )
    .join("\\N");
}

/**
 * Animazione d'entrata (solo sul primo pezzo di una riga) e misura "a riposo". "pop" è quella di
 * sempre: parte piccola, sfocata e ruotata, esplode oltre la sua misura e torna al suo posto in
 * ~180ms; con una parola sola, le urla restano più grandi e tremano.
 */
function cueMotion(cue: CaptionCue, settings: CaptionSettings, baseX: number, baseY: number): string {
  const single = cue.words.length === 1;
  const loud = single ? cue.words[0]!.loud : 0;
  const key = single && cue.words[0]!.key;
  const rest = loud === 2 ? 115 : loud === 1 ? 106 : 100;
  const sx = (p: number) => Math.round((p * baseX) / 100);
  const sy = (p: number) => Math.round((p * baseY) / 100);
  const still = `\\fscx${sx(rest)}\\fscy${sy(rest)}`;
  if (!cue.entrance) return still;

  switch (settings.animation) {
    case "none":
      return still;
    case "fade":
      return `\\fad(120,0)${still}`;
    case "bounce": {
      // Più alta e più elastica del pop, senza rotazione: sale dal basso e rimbalza.
      const entrance =
        `\\fscx${sx(20)}\\fscy${sy(20)}` +
        `\\t(0,90,\\fscx${sx(rest * 1.3)}\\fscy${sy(rest * 1.3)})` +
        `\\t(90,150,\\fscx${sx(rest * 0.88)}\\fscy${sy(rest * 0.88)})` +
        `\\t(150,210,\\fscx${sx(rest * 1.06)}\\fscy${sy(rest * 1.06)})` +
        `\\t(210,260,\\fscx${sx(rest)}\\fscy${sy(rest)})`;
      return entrance + shake(loud);
    }
    default: {
      const [from, peak, dip, tilt] =
        loud === 2 ? [30, 165, 108, 12] : loud === 1 ? [35, 145, 98, 10] : key ? [40, 132, 96, 8] : [45, 122, 96, 6];
      const angle = cue.group % 2 === 0 ? tilt : -tilt;
      const restDip = Math.round((dip * rest) / 100);
      const entrance =
        `\\blur6\\frz${angle}\\fscx${sx(from)}\\fscy${sy(from)}` +
        `\\t(0,70,\\blur0\\frz${Math.round(-angle / 3)}\\fscx${sx(peak)}\\fscy${sy(peak)})` +
        `\\t(70,125,\\frz0\\fscx${sx(restDip)}\\fscy${sy(restDip)})` +
        `\\t(125,180,\\fscx${sx(rest)}\\fscy${sy(rest)})`;
      return entrance + shake(loud);
    }
  }
}

function shake(loud: 0 | 1 | 2): string {
  return loud === 2 ? `\\t(180,230,\\frz-7)\\t(230,280,\\frz7)\\t(280,330,\\frz-5)\\t(330,380,\\frz4)\\t(380,430,\\frz0)` : "";
}
