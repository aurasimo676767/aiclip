import { censorWord } from "../text/censor.js";
import { CAPTION_FONTS, type CaptionSettings } from "./caption-settings.js";

/**
 * Le parole di uno Short con i loro tempi, come le scrive il worker accanto al video (file JSON su
 * R2): servono al sito per disegnare l'anteprima dal vivo e al worker per rifare i sottotitoli
 * cambiando solo lo stile. Tempi in secondi DEL VIDEO FINALE (dopo il taglio dei silenzi).
 */
export interface CaptionTrackWord {
  text: string;
  start: number;
  end: number;
  /** 0 = normale, 1 = voce alzata, 2 = urlo (vedi shoutLevels nel worker). */
  loud: 0 | 1 | 2;
  /** Parola chiave scelta dall'AI. */
  key: boolean;
}

export interface CaptionTrack {
  version: 1;
  duration: number;
  words: CaptionTrackWord[];
  /**
   * Dove stanno i sottotitoli in posizione "auto", tratto per tratto: y = centro della riga in
   * frazione dell'altezza (sulla giunzione webcam/gioco nello split, nel terzo basso altrove).
   */
  anchors: Array<{ start: number; end: number; y: number }>;
  /** Titolo d'apertura proposto (dal titolo dello Short), se c'è. */
  headline: string | null;
}

export interface CaptionCueWord {
  text: string;
  /** Colore della parola quando NON è quella che si sta dicendo. */
  color: string;
  loud: 0 | 1 | 2;
  key: boolean;
}

/** Una cosa da mostrare a schermo fra start e end. */
export interface CaptionCue {
  start: number;
  end: number;
  /** Centro verticale della riga, in frazione dell'altezza del video. */
  y: number;
  words: CaptionCueWord[];
  /** Parola che si sta dicendo (colorata con activeColor), null se nessuna. */
  activeIndex: number | null;
  /** true = la riga entra adesso (animazione d'entrata); false = continua quella di prima. */
  entrance: boolean;
  /** Numero del gruppo: alterna il verso delle animazioni, così due parole di fila non entrano uguali. */
  group: number;
}

/** Una parola resta a schermo fino alla successiva se la pausa è più corta di così (niente lampeggi). */
export const FILL_GAP_SECONDS = 0.35;
/** Dopo l'ultima parola di un gruppo, quanto resta ancora visibile. */
export const LINGER_SECONDS = 0.15;
/** Tempo minimo a schermo di una parola, se la successiva lo permette. */
export const MIN_WORD_SECONDS = 0.18;
/** Un gruppo di più parole si chiude prima di una pausa più lunga di così, o dopo questa durata. */
const GROUP_BREAK_PAUSE_SECONDS = 0.6;
const GROUP_MAX_SECONDS = 3;

const FIXED_Y = { top: 0.2, center: 0.5, bottom: 0.73 } as const;
/** Terzo basso: dove vanno i sottotitoli "auto" quando non c'è una giunzione webcam/gioco. */
export const LOWER_THIRD_Y = 0.73;

export function displayWord(text: string, settings: CaptionSettings): string {
  const clean = censorWord(text.trim());
  return settings.uppercase ? clean.toUpperCase() : clean;
}

function baseColor(word: CaptionTrackWord, settings: CaptionSettings): string {
  if (word.loud > 0 && settings.shoutColor) return settings.shoutColor;
  if (word.key) return settings.highlightColor;
  return settings.textColor;
}

function anchorY(track: CaptionTrack, t: number): number {
  const a = track.anchors.find((x) => t >= x.start && t < x.end) ?? track.anchors[track.anchors.length - 1];
  return a?.y ?? LOWER_THIRD_Y;
}

/** Raggruppa le parole: una alla volta, oppure poche insieme fermandosi alle pause e alla fine delle frasi. */
function groupWords(words: CaptionTrackWord[], perLine: number): CaptionTrackWord[][] {
  if (perLine <= 1) return words.map((w) => [w]);
  const groups: CaptionTrackWord[][] = [];
  let current: CaptionTrackWord[] = [];
  for (const w of words) {
    const prev = current[current.length - 1];
    const first = current[0];
    const breakHere =
      current.length >= perLine ||
      (prev && w.start - prev.end > GROUP_BREAK_PAUSE_SECONDS) ||
      (prev && /[.!?…]$/.test(prev.text.trim())) ||
      (first && w.end - first.start > GROUP_MAX_SECONDS);
    if (current.length > 0 && breakHere) {
      groups.push(current);
      current = [];
    }
    current.push(w);
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Cosa mostrare e quando, per un certo stile. Unica fonte di verità per il worker (che lo traduce in
 * ASS) e per l'anteprima del sito (che lo disegna in HTML): se cambia qui, cambiano tutti e due.
 *
 * - Mai due righe a schermo insieme: ogni gruppo finisce al più quando comincia il successivo (libass
 *   le impilerebbe una sopra l'altra).
 * - Con più parole e activeColor, il gruppo si spezza in un pezzo per parola, ognuno con la sua parola
 *   accesa; solo il primo pezzo ha l'animazione d'entrata.
 * - In posizione "auto" una riga che attraversa un cambio d'inquadratura si sposta dal cambio in poi,
 *   senza rifare l'entrata (dopo uno stacco da split a primo piano finiva in mezzo alla faccia).
 */
export function buildCaptionCues(track: CaptionTrack, settings: CaptionSettings): CaptionCue[] {
  const groups = groupWords(track.words, settings.wordsPerLine);
  const cues: CaptionCue[] = [];
  groups.forEach((group, g) => {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const next = groups[g + 1]?.[0];
    let end = Math.max(last.end, first.start + MIN_WORD_SECONDS);
    if (next) {
      end = next.start - last.end <= FILL_GAP_SECONDS ? next.start : Math.min(end + LINGER_SECONDS, next.start);
    } else {
      end += LINGER_SECONDS;
    }
    if (end - first.start < 0.04) return; // parola "schiacciata" fra due quasi simultanee: si salta

    const words = group.map((w) => ({ text: displayWord(w.text, settings), color: baseColor(w, settings), loud: w.loud, key: w.key }));
    // Pezzi per parola accesa (solo con più parole e un colore per la parola detta).
    const slices: Array<{ start: number; end: number; active: number | null }> = [];
    if (group.length > 1 && settings.activeColor) {
      group.forEach((w, i) => {
        const s = i === 0 ? first.start : w.start;
        const e = i === group.length - 1 ? end : group[i + 1]!.start;
        if (e - s > 0.02) slices.push({ start: s, end: e, active: i });
      });
    } else {
      slices.push({ start: first.start, end, active: null });
    }

    let entrance = true;
    for (const slice of slices) {
      // Spezza ancora ai cambi d'inquadratura (solo "auto").
      const bounds = [slice.start];
      if (settings.position === "auto") {
        for (const a of track.anchors) {
          if (a.start > slice.start + 0.05 && a.start < slice.end - 0.05 && Math.abs(anchorY(track, a.start) - anchorY(track, a.start - 0.01)) > 0.005) bounds.push(a.start);
        }
      }
      bounds.push(slice.end);
      for (let b = 0; b < bounds.length - 1; b++) {
        const start = bounds[b]!;
        const y = settings.position === "auto" ? anchorY(track, start) : FIXED_Y[settings.position];
        cues.push({ start, end: bounds[b + 1]!, y, words, activeIndex: slice.active, entrance, group: g });
        entrance = false;
      }
    }
  });
  return cues;
}

/** Larghezza massima di una riga a schermo (px su 1080): oltre si va a capo o si stringe. */
export const MAX_LINE_WIDTH_PX = 940;

/** Larghezza stimata di un testo, in px su 1080. Le minuscole sono più strette delle maiuscole. */
export function estimateTextWidth(text: string, settings: CaptionSettings): number {
  const ratio = CAPTION_FONTS[settings.font].widthRatio;
  let units = 0;
  for (const ch of text) units += ch === " " ? 0.3 : ch === ch.toUpperCase() ? 1 : 0.82;
  return units * settings.size * ratio;
}

/**
 * Come si dispone una riga: su una o due righe (a capo dove le due metà si equilibrano) e quanto va
 * stretta per stare nello schermo. Una parola sola troppo lunga si stringe solo in orizzontale (come
 * da sempre, "INCREDIBILMENTE" a 124 era larga 1040px); un gruppo si rimpicciolisce tutto.
 */
export function cueLayout(words: CaptionCueWord[], settings: CaptionSettings): { lines: number[][]; scaleX: number; scaleY: number } {
  const width = (from: number, to: number) => estimateTextWidth(words.slice(from, to).map((w) => w.text).join(" "), settings);
  const all = words.map((_, i) => i);
  const total = width(0, words.length);
  if (total <= MAX_LINE_WIDTH_PX) return { lines: [all], scaleX: 1, scaleY: 1 };
  if (words.length === 1) {
    const s = Math.max(0.55, MAX_LINE_WIDTH_PX / total);
    return { lines: [all], scaleX: s, scaleY: 1 };
  }
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(width(0, i) - width(i, words.length));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  const widest = Math.max(width(0, best), width(best, words.length));
  const s = Math.min(1, Math.max(0.55, MAX_LINE_WIDTH_PX / widest));
  return { lines: [all.slice(0, best), all.slice(best)], scaleX: s, scaleY: s };
}

/** Testo del titolo d'apertura che verrà mostrato (personalizzato o quello proposto), o null. */
export function headlineText(track: Pick<CaptionTrack, "headline">, settings: CaptionSettings): string | null {
  if (!settings.headline.enabled) return null;
  const text = (settings.headline.text ?? track.headline ?? "").trim();
  return text.length > 0 ? text : null;
}

/** Fino a quando resta a schermo il titolo d'apertura. */
export function headlineEnd(duration: number, settings: CaptionSettings): number {
  return settings.headline.duration === "intro" ? Math.min(3, duration) : duration;
}
