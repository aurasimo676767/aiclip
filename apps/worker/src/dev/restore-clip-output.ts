import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";

/**
 * Rimette pronta una clip il cui render nuovo è stato annullato prima di caricare: il video di prima
 * è ancora su R2 allo stesso percorso. Controlla che il file esista, poi clip COMPLETED.
 * Uso: tsx src/dev/restore-clip-output.ts <clipId>
 */
const id = process.argv[2]!;
const { data: clip, error } = await supabase.from("clips").select("status,output_video_path").eq("id", id).single();
if (error || !clip?.output_video_path) throw new Error(`Clip senza video: ${error?.message ?? ""}`);
const url = await storageProvider.getSignedUrl(clip.output_video_path, 300);
const head = await fetch(url, { headers: { Range: "bytes=0-0" } });
const size = head.headers.get("content-range")?.split("/")[1];
if (!head.ok || !size) throw new Error(`Video non trovato su R2 (${head.status})`);
const { error: updateError } = await supabase.from("clips").update({ status: "COMPLETED", error_message: null }).eq("id", id).eq("status", "FAILED");
if (updateError) throw new Error(updateError.message);
console.log(`Clip ${id} di nuovo pronta, video ${(Number(size) / 1e9).toFixed(2)} GB`);
