import { z } from "zod";

/**
 * Stile dei sottotitoli di uno Short, scelto dall'editor per il SINGOLO Short (simo, 2026-10-26)
 * vedendolo dal vivo sul video, o salvato come preset con un nome. Lo stesso oggetto lo legge il
 * worker (sottotitoli ASS bruciati nel video, vedi apps/worker/src/render/captions.ts) e il sito
 * (anteprima disegnata sopra il video senza sottotitoli): i due DEVONO dare lo stesso risultato,
 * per questo tutto ciò che decide cosa compare e quando sta in caption-cues.ts, condiviso.
 */

/**
 * Font disponibili: i file stanno in apps/worker/assets/fonts e apps/web/public/fonts. cssScale: a
 * parità di "size", libass disegna le lettere più piccole di CSS (misurato sulla H, vedi
 * apps/worker/src/dev/measure-caption-fonts.ts): l'anteprima del sito usa font-size = size × cssScale.
 */
export const CAPTION_FONTS = {
  arial: { label: "Arial", ass: "Arial", css: "Arial, 'Helvetica Neue', Helvetica, sans-serif", weight: 700, assBold: true, file: null, widthRatio: 0.56, cssScale: 0.901 },
  montserrat: { label: "Montserrat", ass: "Montserrat Black", css: "'CF Montserrat', Arial, sans-serif", weight: 900, assBold: false, file: "Montserrat-Black.ttf", widthRatio: 0.62, cssScale: 0.643 },
  anton: { label: "Anton", ass: "Anton", css: "'CF Anton', Impact, sans-serif", weight: 400, assBold: false, file: "Anton-Regular.ttf", widthRatio: 0.44, cssScale: 0.57 },
  luckiest: { label: "Fumetto", ass: "Luckiest Guy", css: "'CF Luckiest', 'Comic Sans MS', sans-serif", weight: 400, assBold: false, file: "LuckiestGuy-Regular.ttf", widthRatio: 0.6, cssScale: 0.817 },
} as const;
export type CaptionFont = keyof typeof CAPTION_FONTS;

export const HEADLINE_STYLES = {
  classico: "Classico",
  bianco: "Tutto bianco",
  riquadro: "Riquadro",
  verde: "Verde",
  neon: "Neon",
} as const;
export type HeadlineStyle = keyof typeof HEADLINE_STYLES;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const captionSettingsSchema = z.object({
  version: z.literal(1),
  font: z.enum(["arial", "montserrat", "anton", "luckiest"]),
  /** Altezza delle lettere in pixel su un video largo 1080. */
  size: z.number().min(50).max(180),
  uppercase: z.boolean(),
  textColor: hex,
  /** Colore delle parole chiave scelte dall'AI. */
  highlightColor: hex,
  /** Colore della parola che si sta dicendo quando ne sono a schermo più di una (null = nessuno). */
  activeColor: hex.nullable(),
  /** Colore delle parole urlate (null = le urla restano del colore normale). */
  shoutColor: hex.nullable(),
  strokeColor: hex,
  /** Spessore del contorno (0 = niente contorno). */
  strokeWidth: z.number().min(0).max(16),
  /** Distanza dell'ombra (0 = niente ombra). */
  shadow: z.number().min(0).max(10),
  /** Bagliore attorno alle lettere, del colore del contorno (0 = niente). */
  glow: z.number().min(0).max(10),
  /** Riquadro dietro le parole (null = niente riquadro). */
  box: z.object({ color: hex, opacity: z.number().min(0.2).max(1) }).nullable(),
  /** Parole a schermo insieme: 1 = una alla volta, 2-3 = poche, 5 = la frase. */
  wordsPerLine: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5)]),
  // Niente campo "posizione": la decide sempre il PC, dove è sempre stata (giunzione webcam/gioco,
  // terzo basso con la webcam a schermo intero). Scelta di simo, 2026-10-26. I preset salvati prima
  // col campo continuano a funzionare: zod lo scarta.
  animation: z.enum(["pop", "bounce", "fade", "none"]),
  progressBar: z.boolean(),
  headline: z.object({
    enabled: z.boolean(),
    style: z.enum(["classico", "bianco", "riquadro", "verde", "neon"]),
    /** null = il titolo dello Short accorciato. */
    text: z.string().max(60).nullable(),
    /** "intro" = solo i primi 3 secondi, "sempre" = per tutto lo Short. */
    duration: z.enum(["intro", "sempre"]),
  }),
});
export type CaptionSettings = z.infer<typeof captionSettingsSchema>;

export interface CaptionPreset {
  id: string;
  name: string;
  settings: CaptionSettings;
}

const NO_HEADLINE: CaptionSettings["headline"] = { enabled: false, style: "classico", text: null, duration: "intro" };

/** Lo stile usato finora su tutti gli Shorts (deciso con simo a settembre 2026). È quello di partenza. */
export const CLASSIC_CAPTION_SETTINGS: CaptionSettings = {
  version: 1,
  font: "arial",
  size: 124,
  uppercase: true,
  textColor: "#FFFFFF",
  highlightColor: "#FFD400",
  activeColor: null,
  shoutColor: "#FF2E2E",
  strokeColor: "#000000",
  strokeWidth: 8,
  shadow: 4,
  glow: 0,
  box: null,
  wordsPerLine: 1,
  animation: "pop",
  progressBar: false,
  headline: NO_HEADLINE,
};

/** Preset pronti. L'id è stabile (si salva nella clip), il nome è quello mostrato. */
export const BUILTIN_CAPTION_PRESETS: CaptionPreset[] = [
  { id: "classico", name: "Classico", settings: CLASSIC_CAPTION_SETTINGS },
  {
    id: "verde",
    name: "Verde",
    settings: { ...CLASSIC_CAPTION_SETTINGS, font: "montserrat", size: 104, highlightColor: "#3DF36C", activeColor: "#3DF36C", shoutColor: "#3DF36C", strokeWidth: 9, wordsPerLine: 2 },
  },
  // Niente preset col riquadro pieno dietro le parole: simo vuole le scritte sempre "scontornate come
  // un PNG" sopra il video, mai dentro un rettangolo nero (2026-10-26). Il campo box resta nello
  // schema solo per compatibilità e non si mostra.
  {
    id: "ombra",
    name: "Ombra",
    settings: {
      ...CLASSIC_CAPTION_SETTINGS,
      font: "montserrat",
      size: 96,
      highlightColor: "#FFD400",
      activeColor: "#FFD400",
      shoutColor: "#FF4B4B",
      strokeWidth: 3,
      shadow: 8,
      wordsPerLine: 2,
      animation: "pop",
    },
  },
  {
    id: "pulito",
    name: "Pulito",
    settings: {
      ...CLASSIC_CAPTION_SETTINGS,
      font: "montserrat",
      size: 80,
      uppercase: false,
      highlightColor: "#FFFFFF",
      activeColor: "#FFE45C",
      shoutColor: null,
      strokeWidth: 0,
      shadow: 5,
      wordsPerLine: 3,
      animation: "fade",
    },
  },
  {
    id: "impatto",
    name: "Impatto",
    settings: { ...CLASSIC_CAPTION_SETTINGS, font: "anton", size: 150, highlightColor: "#FF2E2E", activeColor: "#FF2E2E", strokeWidth: 10, shadow: 6, wordsPerLine: 2, animation: "bounce" },
  },
  {
    id: "neon",
    name: "Neon",
    settings: {
      ...CLASSIC_CAPTION_SETTINGS,
      font: "montserrat",
      size: 104,
      highlightColor: "#5CF2FF",
      shoutColor: "#FF4FD8",
      strokeColor: "#00B4FF",
      strokeWidth: 5,
      shadow: 0,
      glow: 6,
    },
  },
  {
    id: "karaoke",
    name: "Karaoke",
    settings: { ...CLASSIC_CAPTION_SETTINGS, size: 86, highlightColor: "#FFD400", activeColor: "#FFD400", strokeWidth: 7, shadow: 3, wordsPerLine: 5, animation: "fade" },
  },
  {
    id: "fumetto",
    name: "Fumetto",
    settings: { ...CLASSIC_CAPTION_SETTINGS, font: "luckiest", size: 120, textColor: "#FFE14D", highlightColor: "#FFFFFF", shoutColor: "#FF3B3B", strokeWidth: 10, shadow: 6, animation: "bounce" },
  },
];

/**
 * Impostazioni valide a partire da qualunque cosa arrivi dal database o dal sito: i campi mancanti
 * o sbagliati prendono il valore dello stile Classico, così un preset salvato con una versione
 * vecchia continua a funzionare.
 */
export function normalizeCaptionSettings(raw: unknown): CaptionSettings {
  if (!raw || typeof raw !== "object") return CLASSIC_CAPTION_SETTINGS;
  const merged = {
    ...CLASSIC_CAPTION_SETTINGS,
    ...(raw as Record<string, unknown>),
    headline: { ...CLASSIC_CAPTION_SETTINGS.headline, ...(((raw as Record<string, unknown>).headline as object | undefined) ?? {}) },
    version: 1,
  };
  const parsed = captionSettingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // Campo per campo: tiene tutto ciò che è valido.
  const out: Record<string, unknown> = { ...CLASSIC_CAPTION_SETTINGS };
  for (const key of Object.keys(CLASSIC_CAPTION_SETTINGS) as Array<keyof CaptionSettings>) {
    const field = captionSettingsSchema.shape[key];
    const ok = field.safeParse((merged as Record<string, unknown>)[key]);
    if (ok.success) out[key] = ok.data;
  }
  return out as CaptionSettings;
}
