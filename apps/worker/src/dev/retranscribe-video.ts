import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { extractAudio } from "../pipeline/extract-audio.js";
import { LocalFasterWhisperProvider } from "../providers/transcription/local-faster-whisper-provider.js";
import { env } from "../env.js";

/**
 * Ritrascrive un video già elaborato con Whisper locale (gratis) e sostituisce il transcript salvato.
 * Serve per i VOD trascritti prima del 2026-10-26, quando l'audio andava a Whisper in mp3 a 16 kHz e
 * sopra i suoni dei giochi si perdevano ore di parlato (vedi extract-audio.ts).
 * Uso: tsx src/dev/retranscribe-video.ts <videoId> <sorgente sul PC> [veloce=1 per i VOD]
 */
const [videoId, source, fastArg = "1"] = process.argv.slice(2);
const dir = path.join(env.WORKER_TMP_DIR, `retranscribe-${videoId!.slice(0, 8)}`);
await fsp.mkdir(dir, { recursive: true });
const words = (segments: Array<{ text: string }>) => segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
const { data: old } = await supabase.from("transcripts").select("segments").eq("video_id", videoId!).maybeSingle();
const audio = await extractAudio(source!, dir);
const t = await new LocalFasterWhisperProvider(env.LOCAL_WHISPER_URL, dir).transcribe(audio, { fast: fastArg === "1" });
const { error } = await supabase.from("transcripts").upsert(
  { video_id: videoId!, language: t.language, duration_seconds: t.durationSeconds, full_text: t.fullText, segments: t.segments, provider: t.provider },
  { onConflict: "video_id" },
);
if (error) throw new Error(`Salvataggio fallito: ${error.message}`);
await fsp.rm(dir, { recursive: true, force: true });
console.log(`transcript sostituito: prima ${old ? words(old.segments as Array<{ text: string }>) : 0} parole, ora ${words(t.segments)} (${t.segments.length} frasi)`);
