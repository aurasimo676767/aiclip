import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import type { TranscriptSegment } from "@clipforge/shared";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";
import { measureRmsWindows } from "./word-loudness.js";

/**
 * Trova l'istante ESATTO in cui viene detta una frase: per l'intro "IN QUESTO VIDEO", per i primi
 * piani sulla webcam e per i tagli sui cambi di gioco dei video montati.
 *
 * Perché serve (2026-09-28, test su Call of Duty): i VOD lunghi hanno una trascrizione a blocchi di
 * ~28 s senza i tempi delle parole, quindi l'AI sa COSA viene detto ma non DOVE dentro il blocco.
 * Cercare il punto "più forte" col volume sbagliava: il forte era la musica della lobby o la morte
 * nel gioco, "non urlava nessuno" (simo); e il taglio sul cambio di gioco partiva mentre erano
 * ancora su COD. Qui invece:
 * 1. l'AI dà le parole esatte;
 * 2. si ritrascrivono solo quei ~30 s con Whisper e i tempi delle parole (~0,3 centesimi l'uno,
 *    e un pezzo già ritrascritto si riusa);
 * 3. si cercano le parole.
 * Se la trascrizione ha già i tempi delle parole si usano quelli, senza Whisper.
 */

export interface PhraseQuery {
  /** Tempi della riga della trascrizione in cui l'AI ha visto la frase (secondi dal pezzo). */
  start: number;
  end: number;
  quote: string;
}

export interface LocatedPhrase {
  /** Prima e ultima parola trovate, in secondi dall'inizio del pezzo. */
  start: number;
  end: number;
  /** Volume medio sulle parole trovate (dB): per scegliere le reazioni più forti. */
  loudness: number;
  quote: string;
}

interface Word {
  word: string;
  start: number;
  end: number;
}

function tokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Due parole "uguali" anche se Whisper le scrive un po' diverse (nooo/noooo, cazz/cazzo). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const squash = (s: string) => s.replace(/(.)\1+/g, "$1");
  if (squash(a) === squash(b)) return true;
  return a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
}

/** Dove sono dette le parole della citazione: la finestra di parole che ne contiene di più. */
function findQuote(words: Word[], quote: string): { start: number; end: number; score: number } | null {
  const q = tokens(quote);
  if (q.length === 0 || words.length === 0) return null;
  const w = words.map((x) => ({ ...x, t: tokens(x.word).join("") }));
  let best: { start: number; end: number; score: number } | null = null;
  const span = q.length + 2;
  for (let i = 0; i < w.length; i++) {
    const window = w.slice(i, i + span);
    let matched = 0;
    let lastIdx = -1;
    for (const t of q) {
      const idx = window.findIndex((x, k) => k > lastIdx && sameWord(x.t, t));
      if (idx >= 0) {
        matched++;
        lastIdx = idx;
      }
    }
    const score = matched / q.length;
    if (!best || score > best.score) {
      const first = window.find((x) => q.some((t) => sameWord(x.t, t))) ?? window[0]!;
      best = { start: first.start, end: window[Math.max(0, lastIdx)]!.end, score };
    }
  }
  return best && best.score >= 0.5 ? best : null;
}

/** Cerca le frasi nell'audio di un pezzo di video; riusa le ritrascrizioni fra una ricerca e l'altra. */
export class PhraseLocator {
  private readonly client: OpenAI;
  private readonly windows: Array<{ from: number; to: number; words: Word[] }> = [];
  private dir: string | null = null;
  private whisperSeconds = 0;

  constructor(
    private readonly params: { segments: TranscriptSegment[]; sourceVideoPath: string; clipStart: number; clipDuration: number; openaiApiKey: string },
  ) {
    this.client = new OpenAI({ apiKey: params.openaiApiKey });
  }

  /** Costo di Whisper speso finora (0,006 $ al minuto). */
  get costUsd(): number {
    return (this.whisperSeconds / 60) * 0.006;
  }

  private async wordsBetween(from: number, to: number): Promise<Word[]> {
    const known = this.params.segments
      .filter((s) => s.end > from && s.start < to)
      .flatMap((s) => s.words ?? [])
      .filter((w) => w.start >= from && w.start <= to);
    if (known.length > 0) return known;
    const cached = this.windows.find((w) => w.from <= from + 0.5 && w.to >= to - 0.5);
    if (cached) return cached.words.filter((w) => w.start >= from && w.start <= to);

    this.dir ??= await fsp.mkdtemp(path.join(os.tmpdir(), "phrases-"));
    const audio = path.join(this.dir, `w-${this.windows.length}.mp3`);
    const duration = to - from;
    await runFfmpeg(["-y", "-ss", (this.params.clipStart + from).toFixed(3), "-t", duration.toFixed(3), "-i", this.params.sourceVideoPath, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-b:a", "48k", audio]);
    const response = (await this.client.audio.transcriptions.create({
      file: fs.createReadStream(audio),
      model: "whisper-1",
      language: "it",
      response_format: "verbose_json",
      timestamp_granularities: ["word"],
    })) as unknown as { words?: Word[] };
    this.whisperSeconds += duration;
    const words = (response.words ?? []).map((w) => ({ word: w.word, start: w.start + from, end: w.end + from }));
    this.windows.push({ from, to, words });
    return words;
  }

  /** La frase nel suo intorno, o null se le parole non si trovano. */
  async locate(q: PhraseQuery): Promise<LocatedPhrase | null> {
    const from = Math.max(0, Math.min(q.start, q.end) - 3);
    const to = Math.min(this.params.clipDuration, Math.min(Math.max(q.start, q.end, from + 8) + 3, from + 40));
    let words: Word[];
    try {
      words = await this.wordsBetween(from, to);
    } catch (error) {
      logger.warn("Ritrascrizione di una frase fallita", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
    const found = findQuote(words, q.quote);
    if (!found) {
      logger.info("Frase non trovata nell'audio", { quote: q.quote });
      return null;
    }
    const levels = await measureRmsWindows(this.params.sourceVideoPath, this.params.clipStart + found.start, Math.max(0.3, found.end - found.start));
    const power = levels.filter((db) => db > -90).map((db) => 10 ** (db / 10));
    const loudness = power.length ? 10 * Math.log10(power.reduce((a, b) => a + b, 0) / power.length) : -99;
    return { start: found.start, end: found.end, loudness, quote: q.quote };
  }

  async dispose(): Promise<void> {
    if (this.dir) await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
    logger.info("Frasi cercate nell'audio", { ritrascrittiSecondi: Math.round(this.whisperSeconds), costoWhisperUsd: this.costUsd.toFixed(4) });
  }
}
