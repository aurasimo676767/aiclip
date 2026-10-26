import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { TranscriptSegment } from "@clipforge/shared";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";
import { detectLoudMoments } from "../pipeline/vocal-energy.js";
import { addLoudMomentCandidates } from "../providers/ai/candidates.js";

/**
 * Quali momenti urlati entrerebbero d'ufficio nel ranking di un video già elaborato (gratis:
 * transcript dal database, audio misurato con ffmpeg, nessuna AI).
 * Uso: tsx src/dev/test-loud-candidates.ts <video_id>
 */
const videoId = process.argv[2]!;
const { data: video } = await supabase.from("videos").select("storage_path").eq("id", videoId).single();
const { data: transcript } = await supabase.from("transcripts").select("segments").eq("video_id", videoId).single();
if (!video?.storage_path || !transcript) throw new Error("Video o transcript non trovati");

const local = path.join("tmp", `test-loud-${videoId}.mp4`);
if (!fs.existsSync(local)) await storageProvider.downloadToFile(video.storage_path, local);
const segments = transcript.segments as TranscriptSegment[];
const loud = await detectLoudMoments(local, segments);
const added = addLoudMomentCandidates([], loud, segments);
for (const c of added) console.log(`${c.start.toFixed(0)}-${c.end.toFixed(0)}s  ${c.reason.match(/\+[\d.]+ dB/)?.[0]}  "${c.hook.slice(0, 90)}"`);
fs.rmSync(local, { force: true });
