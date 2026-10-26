import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { extractAudio } from "../pipeline/extract-audio.js";
import { LocalFasterWhisperProvider } from "../providers/transcription/local-faster-whisper-provider.js";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";

/**
 * Prova gratis della trascrizione in FLAC: ritrascrive un tratto del VOD in cache con lo stesso
 * percorso del worker (extractAudio → pezzi → /transcribe-fast) e conta le parole contro il transcript
 * salvato. Uso: tsx src/dev/test-flac-transcript.ts <sorgente> <videoId> <da> <a>
 */
const [source, videoId, fromArg, toArg] = process.argv.slice(2);
const from = Number(fromArg);
const to = Number(toArg);
const dir = path.join(env.WORKER_TMP_DIR, "test-flac");
await fsp.mkdir(dir, { recursive: true });
const cut = path.join(dir, "tratto.mka");
await runFfmpeg(["-y", "-ss", String(from), "-t", String(to - from), "-i", source!, "-map", "0:a:0", "-c", "copy", cut]);
const audio = await extractAudio(cut, dir);
const t = await new LocalFasterWhisperProvider(env.LOCAL_WHISPER_URL, dir).transcribe(audio, { fast: true });
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const nuovo = t.segments.reduce((n, s) => n + words(s.text), 0);
const { data } = await supabase.from("transcripts").select("segments").eq("video_id", videoId!).single();
const vecchio = (data!.segments as Array<{ start: number; text: string }>).filter((s) => s.start >= from && s.start < to).reduce((n, s) => n + words(s.text), 0);
console.log(`${from}-${to}: transcript salvato ${vecchio} parole, nuovo (FLAC) ${nuovo} parole, ${t.segments.length} frasi`);
for (const s of t.segments.slice(0, 12)) console.log(`[${Math.round(s.start + from)}] ${s.text}`);
await fsp.rm(dir, { recursive: true, force: true });
