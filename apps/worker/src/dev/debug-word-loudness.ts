import "dotenv/config";
import type { TranscriptSegment } from "@clipforge/shared";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";
import { getOrDownloadSourceFile } from "../lib/source-download-cache.js";
import { annotateWordLoudness } from "../render/word-loudness.js";

/**
 * Stampa, parola per parola, di quanti dB ogni parola di una clip supera il livello abituale della
 * voce attorno alla clip: serve a tarare le soglie "urlato" dei sottotitoli su clip vere.
 * Uso: tsx src/dev/debug-word-loudness.ts <clip_id>
 */
const clipId = process.argv[2];
if (!clipId) throw new Error("Uso: tsx src/dev/debug-word-loudness.ts <clip_id>");

const { data: clip } = await supabase.from("clips").select("video_id,start_time,end_time,title").eq("id", clipId).single();
if (!clip) throw new Error("Clip non trovata");
const { data: video } = await supabase.from("videos").select("storage_path").eq("id", clip.video_id).single();
const { data: transcript } = await supabase.from("transcripts").select("segments").eq("video_id", clip.video_id).single();
if (!video?.storage_path || !transcript) throw new Error("Sorgente o transcript mancanti");

const source = await getOrDownloadSourceFile(storageProvider, video.storage_path);
const annotated = await annotateWordLoudness(source, transcript.segments as unknown as TranscriptSegment[], clip.start_time, clip.end_time);
const words = annotated.flatMap((s) => s.words).filter((w) => w.start >= clip.start_time && w.start < clip.end_time);

console.log(`\n${clip.title}\n`);
console.log(words.map((w) => `${w.word.trim()}(${(w.loudnessDb ?? 0) >= 0 ? "+" : ""}${(w.loudnessDb ?? 0).toFixed(0)})`).join(" "));
