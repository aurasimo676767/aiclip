import "dotenv/config";
import { supabase } from "../lib/supabase.js";

const VIDEO_ID_ARG = process.argv[2];
if (!VIDEO_ID_ARG) {
  console.error("Uso: tsx src/dev/retry-video.ts <video_id>");
  process.exit(1);
}
const VIDEO_ID: string = VIDEO_ID_ARG;

// Replica esatta di apps/web/src/app/api/projects/[id]/retry/route.ts
async function main() {
  const { data: video, error: videoErr } = await supabase.from("videos").select("id, project_id, status").eq("id", VIDEO_ID).single();
  if (videoErr || !video) throw new Error(`Video non trovato: ${videoErr?.message}`);
  if (video.status !== "FAILED") {
    throw new Error(`Il video non è in stato FAILED (è "${video.status}"), il pulsante Riprova richiederebbe lo stesso stato.`);
  }

  const { error: updateVideoError } = await supabase
    .from("videos")
    .update({ status: "UPLOADED", error_message: null, claimed_by: null, claimed_at: null, attempts: 0, cancel_requested: false })
    .eq("id", video.id);
  if (updateVideoError) throw new Error(`Aggiornamento video fallito: ${updateVideoError.message}`);

  const { error: updateProjectError } = await supabase
    .from("projects")
    .update({ status: "UPLOADED", error_message: null })
    .eq("id", video.project_id);
  if (updateProjectError) throw new Error(`Aggiornamento progetto fallito: ${updateProjectError.message}`);

  console.log(`Video ${VIDEO_ID} rimesso in coda (status=UPLOADED, attempts=0).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
