import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CaptionStyleConfig, TranscriptSegment, TranscriptWord } from "@clipforge/shared";
import { OUTPUT_RESOLUTION } from "@clipforge/shared";
import type { Layout } from "../face-tracking/face-tracker.js";
import { toFfmpegFilterPath } from "./ffmpeg-filter-utils.js";

interface WordChunk {
  words: TranscriptWord[];
  start: number;
  end: number;
}

const MAX_WORDS_PER_CHUNK = 6;
const MAX_CHUNK_DURATION_SECONDS = 4;

/**
 * Cartella dei font inclusi nel progetto, passata a ffmpeg (`fontsdir`). Senza, libass cerca il
 * font fra quelli installati sul PC e, se manca, ripiega IN SILENZIO su un altro: tutti gli Shorts
 * usciti fino al 25/09/2026 chiedevano "Montserrat ExtraBold"/"Poppins Black", mai installati, e
 * venivano scritti in Arial.
 */
export const CAPTION_FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../assets/fonts");

/** Il filtro `subtitles` di ffmpeg con i font del progetto. Usarlo per ogni sottotitolo bruciato. */
export function subtitlesFilter(assPath: string): string {
  return `subtitles='${toFfmpegFilterPath(assPath)}':fontsdir='${toFfmpegFilterPath(CAPTION_FONTS_DIR)}'`;
}

/**
 * Una parola resta a schermo fino alla successiva se la pausa fra le due è più corta di così: le
 * parole sparivano nei buchi fra una e l'altra e il testo lampeggiava.
 */
const FILL_GAP_SECONDS = 0.35;
/** Dopo l'ultima parola di una frase, quanto resta ancora visibile. */
const LINGER_SECONDS = 0.15;
/** Tempo minimo a schermo di una parola, se la successiva lo permette. */
const MIN_WORD_SECONDS = 0.18;

/**
 * Genera un file di sottotitoli ASS per una clip, sincronizzato parola per parola. `segments`
 * contiene già solo le parole della clip, con tempi clip-relativi (0 = inizio clip) e già
 * rimappati per la rimozione dei silenzi (vedi silence.ts).
 *
 * - wordByWord + oneWordAtATime (Shorts): UNA parola alla volta, bianca con contorno spesso, con un
 *   piccolo "pop" d'ingresso; gialle solo le parole chiave scelte dall'AI (`highlightWords`).
 * - wordByWord senza oneWordAtATime: gruppi di poche parole con evidenziazione karaoke.
 * - wordByWord=false: una riga per frase, colore statico.
 * - position="smart" (richiede `layout`): la riga si mette dove non copre niente nell'inquadratura
 *   di QUEL momento — sulla giunzione fra webcam e contenuto nello split, nel terzo basso sui
 *   primi piani, sotto il video nel frame intero (vedi smartPosition).
 */
export function buildAssSubtitles(
  segments: TranscriptSegment[],
  style: CaptionStyleConfig,
  options: { highlightWords?: Set<string>; layout?: Layout } = {},
): string {
  const highlightWords = options.highlightWords ?? new Set<string>();
  const alignment = style.position === "top" ? 8 : style.position === "center" ? 5 : 2;
  const marginV = style.position === "center" ? 0 : 160;

  const header = buildHeader(style, alignment, marginV);
  const events = !style.wordByWord
    ? buildPlainEvents(segments, style)
    : style.oneWordAtATime
      ? buildSingleWordEvents(segments, style, highlightWords, options.layout)
      : buildKaraokeEvents(segments, style, highlightWords, options.layout);

  return `${header}\n${events.join("\n")}\n`;
}

function buildHeader(style: CaptionStyleConfig, alignment: number, marginV: number): string {
  const primary = hexToAssColor(style.textColor);
  const secondary = hexToAssColor(style.highlightColor);
  const outline = hexToAssColor(style.outlineColor);

  // Grassetto (Arial Bold, lo stile che simo vuole), contorno 8 e ombra 4: su una webcam o un
  // gioco colorato il contorno sottile di prima (6) si perdeva, e la parola era difficile da
  // leggere su un telefono.
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${OUTPUT_RESOLUTION.width}
PlayResY: ${OUTPUT_RESOLUTION.height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontFamily},${style.fontSize},${primary},${secondary},${outline},&H80000000,-1,0,0,0,100,100,1,0,1,8,4,${alignment},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
}

function buildPlainEvents(segments: TranscriptSegment[], style: CaptionStyleConfig): string[] {
  const lines = segments.filter((seg) => seg.words.length > 0).sort((a, b) => a.start - b.start);
  return lines.map((seg, i) => {
    const text = applyTextCase(seg.text.trim(), style.uppercase);
    // Mai due righe a schermo insieme: libass le IMPILEREBBE una sopra l'altra.
    const next = lines[i + 1];
    const end = next ? Math.min(seg.end, next.start) : seg.end;
    return `Dialogue: 0,${formatAssTime(seg.start)},${formatAssTime(end)},Default,,0,0,0,,${escapeAssText(text)}`;
  });
}

/**
 * Una parola alla volta (stile richiesto da simo dopo due Shorts di riferimento).
 *
 * Errori della versione precedente, visti sui render veri:
 * - due parole sovrapposte anche di un centesimo venivano IMPILATE da libass ("QUESTO/QUESTO"
 *   su due righe): qui ogni parola finisce al più quando comincia la successiva;
 * - il colore cambiava a caso fra bianco e azzurro: era l'effetto karaoke (\k), pensato per una
 *   frase intera, applicato a una parola sola, dove il risultato dipendeva dagli arrotondamenti.
 *   Ora il colore ha un significato: bianco, e il colore d'evidenza solo sulle parole chiave.
 */
function buildSingleWordEvents(
  segments: TranscriptSegment[],
  style: CaptionStyleConfig,
  highlightWords: Set<string>,
  layout: Layout | undefined,
): string[] {
  const words = spokenWords(segments);
  const shoutLevel = shoutLevels(words);

  const events: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const next = words[i + 1];
    let end = Math.max(word.end, word.start + MIN_WORD_SECONDS);
    if (next) {
      end = next.start - word.end <= FILL_GAP_SECONDS ? next.start : Math.min(end + LINGER_SECONDS, next.start);
    } else {
      end += LINGER_SECONDS;
    }
    if (end - word.start < 0.04) continue; // parola "schiacciata" fra due quasi simultanee: si salta

    const text = applyTextCase(word.word.trim(), style.uppercase);
    const isHighlighted = highlightWords.has(normalizeWord(text));
    const shout = shoutLevel.get(word) ?? 0;
    const color = shout > 0 ? `\\c${SHOUT_COLOR}` : isHighlighted ? `\\c${hexToAssColor(style.highlightColor)}` : "";
    // Misura "a riposo" della parola dopo l'entrata: le urla restano più grandi.
    const rest = shout === 2 ? 115 : shout === 1 ? 106 : 100;
    const fit = widthFitPercent(text, (style.fontSize * rest) / 100);
    const pct = (p: number) => Math.round((p * fit) / 100);
    const pop = popAnimation(shout, isHighlighted, i, pct, rest);

    // Una parola che attraversa un cambio d'inquadratura si sposta nel punto giusto dal cambio in
    // poi, senza rifare il pop: prima restava dov'era, e dopo uno stacco da split a primo piano
    // finiva in mezzo alla faccia.
    const pieces = style.position === "smart" ? splitAtLayoutChanges(layout, word.start, end) : [{ start: word.start, end }];
    pieces.forEach((piece, p) => {
      const position = style.position === "smart" ? smartPosition(layout, piece.start) : "";
      const animation = p === 0 ? pop : `\\fscx${pct(rest)}\\fscy${rest}`;
      events.push(
        `Dialogue: 0,${formatAssTime(piece.start)},${formatAssTime(piece.end)},Default,,0,0,0,,{${position}${color}${animation}}${escapeAssText(text)}`,
      );
    });
  }
  return events;
}

function buildKaraokeEvents(
  segments: TranscriptSegment[],
  style: CaptionStyleConfig,
  highlightWords: Set<string>,
  layout: Layout | undefined,
): string[] {
  const chunks = segments.flatMap((seg) => chunkWords(seg.words, MAX_WORDS_PER_CHUNK)).sort((a, b) => a.start - b.start);
  return chunks.map((chunk, i) => {
    const parts = chunk.words.map((word) => {
      const durationCentis = Math.max(1, Math.round((word.end - word.start) * 100));
      const text = applyTextCase(word.word.trim(), style.uppercase);
      const escaped = escapeAssText(text);
      return highlightWords.has(normalizeWord(text))
        ? `{\\k${durationCentis}}{\\c${hexToAssColor(style.highlightColor)}}${escaped}{\\r} `
        : `{\\k${durationCentis}}${escaped} `;
    });
    const next = chunks[i + 1];
    const end = next ? Math.min(chunk.end, next.start) : chunk.end;
    const override = style.position === "smart" ? `{${smartPosition(layout, chunk.start)}}` : "";
    return `Dialogue: 0,${formatAssTime(chunk.start)},${formatAssTime(end)},Default,,0,0,0,,${override}${parts.join("")}`;
  });
}

/**
 * Entrata "a schiaffo" di una parola, voluta da simo per gli Shorts ("qualcosa che lobotomizza chi
 * guarda e lo fa fissare i sottotitoli"): parte piccola, sfocata e ruotata, esplode oltre la sua
 * misura e rimbalza al suo posto in ~180ms. La rotazione d'ingresso alterna verso a ogni parola, così
 * due parole di fila non entrano mai uguali. Più forte è la parola, più grande il salto; le urla
 * dopo l'entrata tremano.
 */
function popAnimation(shout: 0 | 1 | 2, isHighlighted: boolean, index: number, pct: (p: number) => number, rest: number): string {
  const [from, peak, dip, tilt] =
    shout === 2 ? [30, 165, 108, 12] : shout === 1 ? [35, 145, 98, 10] : isHighlighted ? [40, 132, 96, 8] : [45, 122, 96, 6];
  const angle = index % 2 === 0 ? tilt : -tilt;
  const restDip = Math.round((dip * rest) / 100);
  const entrance =
    `\\blur6\\frz${angle}\\fscx${pct(from)}\\fscy${from}` +
    `\\t(0,70,\\blur0\\frz${Math.round(-angle / 3)}\\fscx${pct(peak)}\\fscy${peak})` +
    `\\t(70,125,\\frz0\\fscx${pct(restDip)}\\fscy${restDip})` +
    `\\t(125,180,\\fscx${pct(rest)}\\fscy${rest})`;
  const shake =
    shout === 2 ? `\\t(180,230,\\frz-7)\\t(230,280,\\frz7)\\t(280,330,\\frz-5)\\t(330,380,\\frz4)\\t(380,430,\\frz0)` : "";
  return entrance + shake;
}

/** Rosso delle parole urlate (formato colore ASS, &HBBGGRR). */
const SHOUT_COLOR = "&H002E2EFF";
/**
 * Soglie delle urla, in dB sopra il parlato abituale attorno alla clip (vedi word-loudness.ts).
 * Misurate su clip vere: il parlato normale sta fra 0 e +3, la voce alzata a +5/+6, le urla vere a
 * +7/+8 (uno sfogo: "sei un rotto in culo" = +7 +7 +6 +8, la frase detta normalmente -1).
 */
const LOUD_DB = 5;
const SCREAM_DB = 7;
/**
 * Solo la parte più forte della clip può diventare rossa per le soglie assolute: in una clip urlata
 * dall'inizio alla fine altrimenti sarebbe rosso tutto, e il rosso smetterebbe di dire "qui urla".
 */
const LOUD_TOP_SHARE = 0.4;
/**
 * Quota di parole rosse ANCHE quando nessuno urla (scelta di simo: "ci deve essere a prescindere",
 * ~1 parola su 6): le più forti della clip rispetto al resto della clip stessa.
 */
const RELATIVE_RED_SHARE = 1 / 6;
/** Le parole rosse "relative" devono avere almeno tante lettere: un "E" rosso non dice niente. */
const MIN_RED_WORD_LETTERS = 3;

/** 0 = normale, 1 = voce alzata, 2 = urlo. */
function shoutLevels(words: TranscriptWord[]): Map<TranscriptWord, 0 | 1 | 2> {
  const levels = new Map<TranscriptWord, 0 | 1 | 2>();
  const measured = words.map((w) => w.loudnessDb).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
  if (measured.length === 0) return levels;
  const topCut = measured[Math.floor(measured.length * (1 - LOUD_TOP_SHARE))] ?? Infinity;
  const relativeCut = measured[Math.floor(measured.length * (1 - RELATIVE_RED_SHARE))] ?? Infinity;
  for (const w of words) {
    const db = w.loudnessDb;
    if (db === undefined) continue;
    if (db >= SCREAM_DB && db >= topCut) levels.set(w, 2);
    else if ((db >= LOUD_DB && db >= topCut) || (db >= relativeCut && normalizeWord(w.word).length >= MIN_RED_WORD_LETTERS)) levels.set(w, 1);
  }
  return levels;
}

/** Larghezza massima di una parola a schermo (px su 1080): oltre, la parola viene ristretta. */
const MAX_WORD_WIDTH_PX = 940;
/**
 * Larghezza media di un carattere di Arial Bold maiuscolo, in frazioni della dimensione del font.
 * Misurata: "INCREDIBILMENTE" (15 lettere) a 124 è larga ~1040px — oltre lo schermo senza
 * restringerla.
 */
const FONT_CHAR_WIDTH_RATIO = 0.56;

/** Percentuale di larghezza (\fscx) perché la parola stia nello schermo: 100 se ci sta già. */
function widthFitPercent(text: string, fontSize: number): number {
  const estimated = text.length * fontSize * FONT_CHAR_WIDTH_RATIO;
  return estimated <= MAX_WORD_WIDTH_PX ? 100 : Math.max(55, Math.floor((MAX_WORD_WIDTH_PX / estimated) * 100));
}

/** Divide [start, end] nei punti in cui cambia la posizione dei sottotitoli (cambi di scena). */
function splitAtLayoutChanges(layout: Layout | undefined, start: number, end: number): Array<{ start: number; end: number }> {
  if (!layout || layout.type !== "scenes") return [{ start, end }];
  const cuts = layout.scenes
    .map((s) => s.startSeconds)
    .filter((t) => t > start + 0.05 && t < end - 0.05 && smartPosition(layout, t) !== smartPosition(layout, t - 0.01));
  const bounds = [start, ...cuts, end];
  return bounds.slice(0, -1).map((b, i) => ({ start: b, end: bounds[i + 1]! }));
}

/**
 * Le parole della clip pronte per essere mostrate: ordinate, senza doppioni, con le elisioni
 * riunite. Usata sia dai sottotitoli sia dai primi piani sugli urli (vedi screamWindows), così
 * "urlo" vuol dire esattamente la stessa cosa nei due posti.
 */
export function spokenWords(segments: TranscriptSegment[]): TranscriptWord[] {
  const sorted = segments
    .flatMap((seg) => seg.words)
    .filter((w) => w.word.trim().length > 0 && w.end > w.start)
    .sort((a, b) => a.start - b.start);
  // Doppioni: i transcript salvati prima della correzione del provider hanno le parole sul confine
  // fra due frasi ripetute due volte, con gli stessi tempi.
  const deduped = sorted.filter((w, i) => {
    const prev = sorted[i - 1];
    return !prev || Math.abs(prev.start - w.start) > 0.05 || normalizeWord(prev.word) !== normalizeWord(w.word);
  });
  // Elisioni: Whisper spezza "l'acqua" in "l" + "'acqua" e "c'ho" in "c" + "'ho", che a una parola
  // alla volta uscivano come "L", poi "'ACQUA". Si riuniscono in una parola sola.
  const words: TranscriptWord[] = [];
  for (const w of deduped) {
    const prev = words[words.length - 1];
    if (prev && /^['’]/.test(w.word.trim())) {
      words[words.length - 1] = {
        ...prev,
        word: prev.word.trim() + w.word.trim(),
        end: w.end,
        loudnessDb:
          prev.loudnessDb === undefined && w.loudnessDb === undefined
            ? undefined
            : Math.max(prev.loudnessDb ?? -Infinity, w.loudnessDb ?? -Infinity),
      };
    } else {
      words.push(w);
    }
  }
  return words;
}

/**
 * Tratti della clip in cui qualcuno URLA (livello 2, vedi shoutLevels): lì il render fa un
 * primo piano netto. Urli vicini (meno di 0.4s) sono un tratto solo; ogni tratto dura almeno 0.5s
 * e al massimo 2s, e fra due tratti passano almeno 3s — un primo piano ogni secondo non è più un
 * accento, è un'inquadratura che salta.
 */
export function screamWindows(segments: TranscriptSegment[]): Array<{ start: number; end: number }> {
  const words = spokenWords(segments);
  const levels = shoutLevels(words);
  const windows: Array<{ start: number; end: number }> = [];
  for (const w of words) {
    if (levels.get(w) !== 2) continue;
    const last = windows[windows.length - 1];
    if (last && w.start - last.end < 0.4) {
      last.end = Math.min(last.start + 2, w.end + 0.25);
      continue;
    }
    if (last && w.start - last.end < 3) continue;
    const start = Math.max(0, w.start - 0.05);
    windows.push({ start, end: Math.max(start + 0.5, Math.min(start + 2, w.end + 0.25)) });
  }
  return windows;
}

/** Altezza (frazione dello schermo) dei sottotitoli sui primi piani e sul frame intero. */
const LOWER_THIRD_Y_RATIO = 0.73;

/**
 * Posizione della riga in base all'inquadratura attiva all'istante `t`:
 * - split (webcam sopra, contenuto sotto): sulla giunzione fra i due pannelli — leggibile, e non
 *   copre né il volto né il contenuto;
 * - primo piano (ritaglio a schermo intero): nel terzo basso, sotto il volto;
 * - frame intero su sfondo sfocato: subito sotto il video, sullo sfondo sfocato (per un 16:9 il
 *   video occupa la fascia centrale fino a ~1264px).
 * Prima, nel layout "scene", stava sempre in basso: sopra il gioco o il mento dello streamer.
 */
function smartPosition(layout: Layout | undefined, t: number): string {
  const x = Math.round(OUTPUT_RESOLUTION.width / 2);
  const lowerThird = Math.round(OUTPUT_RESOLUTION.height * LOWER_THIRD_Y_RATIO);
  if (!layout) return `\\an5\\pos(${x},${lowerThird})`;
  if (layout.type === "split_vertical") return `\\an5\\pos(${x},${Math.round(OUTPUT_RESOLUTION.height * layout.topRatio)})`;

  const scene = layout.scenes.find((s) => t >= s.startSeconds && t < s.endSeconds) ?? layout.scenes[layout.scenes.length - 1];
  if (scene?.composition.kind === "split") {
    return `\\an5\\pos(${x},${Math.round(OUTPUT_RESOLUTION.height * scene.composition.topRatio)})`;
  }
  return `\\an5\\pos(${x},${lowerThird})`;
}

function chunkWords(words: TranscriptWord[], maxWords: number): WordChunk[] {
  const chunks: WordChunk[] = [];
  let current: TranscriptWord[] = [];

  for (const word of words) {
    const wouldExceedCount = current.length + 1 > maxWords;
    const first = current[0];
    const wouldExceedDuration = first ? word.end - first.start > MAX_CHUNK_DURATION_SECONDS : false;

    if (current.length > 0 && (wouldExceedCount || wouldExceedDuration)) {
      chunks.push(toChunk(current));
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) {
    chunks.push(toChunk(current));
  }
  return chunks;
}

function toChunk(words: TranscriptWord[]): WordChunk {
  const first = words[0];
  const last = words[words.length - 1];
  if (!first || !last) {
    throw new Error("toChunk: lista di parole vuota");
  }
  return { words, start: first.start, end: last.end };
}

function normalizeWord(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

function applyTextCase(text: string, uppercase: boolean): string {
  return uppercase ? text.toUpperCase() : text;
}

// Esportate: riusate anche fuori da questo file per generare ASS "minimali" non legati a
// sottotitoli parlati (es. la card dei crediti del render long-form, vedi render-longform-clip.ts).
export function escapeAssText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\n/g, "\\N");
}

export function formatAssTime(seconds: number): string {
  // Si arrotonda UNA volta sui centesimi totali: arrotondando solo la parte decimale, 1.996 dava
  // "0:00:01.100" (centesimi = 100), cioè un tempo sbagliato.
  const totalCentis = Math.round(Math.max(0, seconds) * 100);
  const h = Math.floor(totalCentis / 360000);
  const m = Math.floor((totalCentis % 360000) / 6000);
  const s = Math.floor((totalCentis % 6000) / 100);
  const centis = totalCentis % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

/** Converte un colore #RRGGBB in formato colore ASS &HAABBGGRR (alpha 00 = opaco). */
function hexToAssColor(hex: string): string {
  const clean = hex.replace("#", "");
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}
