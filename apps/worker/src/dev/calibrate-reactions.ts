import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { measureRmsWindows, WINDOW_SECONDS } from "../render/word-loudness.js";
import { LocalFasterWhisperProvider } from "../providers/transcription/local-faster-whisper-provider.js";
import { env } from "../env.js";

/**
 * Taratura gratis della soglia "reazione forte" dei primi piani: livello abituale del tratto del VOD
 * (mediana a finestre da 0,5 s, come il montaggio), poi per ogni frase di alcuni tratti quanti dB
 * sopra quel livello arriva il picco. Uso: tsx src/dev/calibrate-reactions.ts <sorgente> <inizio> <fine> <da-a>...
 */
const [source, startArg, endArg, ...windows] = process.argv.slice(2);
const start = Number(startArg);
const end = Number(endArg);
const levels = await measureRmsWindows(source!, start, end - start);
const per = Math.round(0.5 / WINDOW_SECONDS);
const bins: number[] = [];
for (let i = 0; i < levels.length; i += per) {
  const slice = levels.slice(i, i + per);
  const power = slice.reduce((sum, db) => sum + Math.pow(10, db / 10), 0) / slice.length;
  bins.push(power > 0 ? 10 * Math.log10(power) : -100);
}
const audible = bins.filter((db) => db > -90).sort((a, b) => a - b);
const baseline = audible[Math.floor(audible.length / 2)]!;
console.log(`livello abituale ${baseline.toFixed(1)} dB`);
const dir = path.join(env.WORKER_TMP_DIR, "calibra");
await fsp.mkdir(dir, { recursive: true });
for (const w of windows) {
  const [a, b] = w.split("-").map(Number) as [number, number];
  const audio = path.join(dir, `w${a}.flac`);
  await runFfmpeg(["-y", "-ss", String(a), "-t", String(b - a), "-i", source!, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "flac", audio]);
  const t = await new LocalFasterWhisperProvider(env.LOCAL_WHISPER_URL, dir).transcribe(audio);
  for (const s of t.segments) {
    const from = Math.floor((a + s.start - start) / 0.5);
    const to = Math.max(from + 1, Math.ceil((a + s.end - start) / 0.5));
    const peak = Math.max(...bins.slice(from, to));
    console.log(`[${Math.round(a + s.start)}] +${(peak - baseline).toFixed(1)} dB  ${s.text.slice(0, 90)}`);
  }
}
await fsp.rm(dir, { recursive: true, force: true });
