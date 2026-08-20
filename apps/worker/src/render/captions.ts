import type { CaptionStyleConfig, TranscriptSegment, TranscriptWord } from "@clipforge/shared";
import { OUTPUT_RESOLUTION } from "@clipforge/shared";

interface WordChunk {
  words: TranscriptWord[];
  start: number;
  end: number;
}

const MAX_WORDS_PER_CHUNK = 6;
const MAX_CHUNK_DURATION_SECONDS = 4;

/**
 * Genera un file di sottotitoli in formato ASS (Advanced SubStation Alpha) per una clip,
 * sincronizzato parola-per-parola. `words` deve contenere già solo le parole della clip,
 * con timestamp clip-relativi (0 = inizio clip) e già rimappati per l'eventuale rimozione
 * dei silenzi (vedi silence.ts).
 *
 * - wordByWord=true (template dinamici): una riga per "chunk" di poche parole, con tag
 *   karaoke \k per l'effetto di evidenziazione progressiva parola-per-parola.
 * - wordByWord=false (template puliti): una riga per segmento/frase, colore statico.
 *
 * `highlightWords` (dall'EDL, evento highlight_word) forza un colore di evidenziazione
 * statico sulle parole corrispondenti, indipendentemente dal karaoke sweep.
 */
export function buildAssSubtitles(
  segments: TranscriptSegment[],
  style: CaptionStyleConfig,
  options: { highlightWords?: Set<string> } = {},
): string {
  const highlightWords = options.highlightWords ?? new Set<string>();
  const alignment = style.position === "top" ? 8 : style.position === "center" ? 5 : 2;
  const marginV = style.position === "center" ? 0 : 120;

  const header = buildHeader(style, alignment, marginV);
  const events = style.wordByWord
    ? buildKaraokeEvents(segments, style, highlightWords)
    : buildPlainEvents(segments, style);

  return `${header}\n${events.join("\n")}\n`;
}

function buildHeader(style: CaptionStyleConfig, alignment: number, marginV: number): string {
  const primary = hexToAssColor(style.textColor);
  const secondary = hexToAssColor(style.highlightColor);
  const outline = hexToAssColor(style.outlineColor);

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${OUTPUT_RESOLUTION.width}
PlayResY: ${OUTPUT_RESOLUTION.height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontFamily},${style.fontSize},${primary},${secondary},${outline},&H64000000,-1,0,0,0,100,100,0,0,1,4,2,${alignment},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
}

function buildPlainEvents(segments: TranscriptSegment[], style: CaptionStyleConfig): string[] {
  return segments
    .filter((seg) => seg.words.length > 0)
    .map((seg) => {
      const text = applyTextCase(seg.text.trim(), style.uppercase);
      return `Dialogue: 0,${formatAssTime(seg.start)},${formatAssTime(seg.end)},Default,,0,0,0,,${escapeAssText(text)}`;
    });
}

function buildKaraokeEvents(
  segments: TranscriptSegment[],
  style: CaptionStyleConfig,
  highlightWords: Set<string>,
): string[] {
  const chunks = segments.flatMap((seg) => chunkWords(seg.words));
  return chunks.map((chunk) => {
    const parts = chunk.words.map((word) => {
      const durationCentis = Math.max(1, Math.round((word.end - word.start) * 100));
      const text = applyTextCase(word.word.trim(), style.uppercase);
      const normalized = text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
      const isHighlighted = highlightWords.has(normalized);
      const escaped = escapeAssText(text);
      return isHighlighted ? `{\\k${durationCentis}}{\\c${hexToAssColor(style.highlightColor)}}${escaped}{\\r} ` : `{\\k${durationCentis}}${escaped} `;
    });
    return `Dialogue: 0,${formatAssTime(chunk.start)},${formatAssTime(chunk.end)},Default,,0,0,0,,${parts.join("")}`;
  });
}

function chunkWords(words: TranscriptWord[]): WordChunk[] {
  const chunks: WordChunk[] = [];
  let current: TranscriptWord[] = [];

  for (const word of words) {
    const wouldExceedCount = current.length + 1 > MAX_WORDS_PER_CHUNK;
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

function applyTextCase(text: string, uppercase: boolean): string {
  return uppercase ? text.toUpperCase() : text;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\n/g, "\\N");
}

function formatAssTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const centis = Math.round((clamped - Math.floor(clamped)) * 100);
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
