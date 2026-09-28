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
 * Trova l'istante ESATTO dei momenti dell'intro "IN QUESTO VIDEO".
 *
 * Perché serve (2026-09-28, secondo test su Call of Duty): i VOD lunghi hanno una trascrizione a
 * blocchi di ~28 s senza i tempi delle parole, quindi l'AI sa COSA viene detto ma non DOVE dentro il
 * blocco. Cercare poi il punto "più forte" con il volume sbagliava: il forte era la musica della
 * lobby o la morte nel gioco, "non urlava nessuno" (simo). Qui invece:
 * 1. l'AI dà le parole esatte della reazione (urlo, insulto, risata);
 * 2. si ritrascrivono solo quei ~30 s con Whisper e i tempi delle parole (~0,3 centesimi l'uno);
 * 3. si cercano le parole e la clip parte mezzo secondo prima.
 * Se la trascrizione ha già i tempi delle parole si usano quelli, senza Whisper.
 */

export interface IntroCandidate {
  start: number;
  end: number;
  quote: string;
}

export interface LocatedIntroMoment {
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

const LEAD_SECONDS = 0.5;
const TAIL_SECONDS = 1.2;
const MIN_SECONDS = 2;
const MAX_SECONDS = 5;

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

async function transcribeWindow(client: OpenAI, sourcePath: string, from: number, duration: number, dir: string, i: number): Promise<Word[]> {
  const audio = path.join(dir, `intro-${i}.mp3`);
  await runFfmpeg(["-y", "-ss", from.toFixed(3), "-t", duration.toFixed(3), "-i", sourcePath, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-b:a", "48k", audio]);
  const response = (await client.audio.transcriptions.create({
    file: fs.createReadStream(audio),
    model: "whisper-1",
    language: "it",
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  })) as unknown as { words?: Word[] };
  return (response.words ?? []).map((w) => ({ word: w.word, start: w.start + from, end: w.end + from }));
}

/**
 * Colloca i candidati dell'AI (tempi dall'inizio del pezzo `clipStart` nel sorgente). Ritorna i
 * momenti trovati, in tempi del pezzo; quelli di cui non si trovano le parole si scartano.
 */
export async function locateIntroMoments(params: {
  candidates: IntroCandidate[];
  segments: TranscriptSegment[];
  sourceVideoPath: string;
  clipStart: number;
  clipDuration: number;
  openaiApiKey: string;
}): Promise<LocatedIntroMoment[]> {
  const client = new OpenAI({ apiKey: params.openaiApiKey });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "intro-"));
  const out: LocatedIntroMoment[] = [];
  let whisperSeconds = 0;
  try {
    for (const [i, c] of params.candidates.entries()) {
      // La riga (o le righe) della trascrizione in cui l'AI ha visto la citazione, con un po' di margine.
      const from = Math.max(0, Math.min(c.start, c.end) - 3);
      const to = Math.min(params.clipDuration, Math.max(c.start, c.end, from + 8) + 3);
      let words: Word[] = params.segments
        .filter((s) => s.end > from && s.start < to)
        .flatMap((s) => s.words ?? [])
        .filter((w) => w.start >= from && w.start <= to);
      try {
        if (words.length === 0) {
          const window = Math.min(to - from, 40);
          words = (await transcribeWindow(client, params.sourceVideoPath, params.clipStart + from, window, dir, i)).map((w) => ({
            ...w,
            start: w.start - params.clipStart,
            end: w.end - params.clipStart,
          }));
          whisperSeconds += window;
        }
      } catch (error) {
        logger.warn("Intro: ritrascrizione fallita", { error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const found = findQuote(words, c.quote);
      if (!found) {
        logger.info("Intro: parole non trovate, momento scartato", { quote: c.quote });
        continue;
      }
      const start = Math.max(0, found.start - LEAD_SECONDS);
      const end = Math.min(params.clipDuration, Math.max(start + MIN_SECONDS, Math.min(found.end + TAIL_SECONDS, start + MAX_SECONDS)));
      const levels = await measureRmsWindows(params.sourceVideoPath, params.clipStart + found.start, Math.max(0.3, found.end - found.start));
      const power = levels.filter((db) => db > -90).map((db) => 10 ** (db / 10));
      const loudness = power.length ? 10 * Math.log10(power.reduce((a, b) => a + b, 0) / power.length) : -99;
      out.push({ start, end, loudness, quote: c.quote });
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  logger.info("Intro: momenti collocati sulle parole", {
    trovati: out.map((m) => `${m.start.toFixed(1)}-${m.end.toFixed(1)} ${m.loudness.toFixed(1)}dB "${m.quote}"`),
    costoWhisperUsd: ((whisperSeconds / 60) * 0.006).toFixed(4),
  });
  return out;
}
