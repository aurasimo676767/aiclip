import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/**
 * Segna come completato un invio TikTok già pubblicato ma rimasto "in caricamento" (es. worker
 * ripartito dopo l'invio a Zernio): evita che il worker lo rimandi e crei un doppione.
 * Uso: tsx src/dev/tiktok-job-complete.ts <jobId> <postId> <url>
 */
const [jobId, postId, url] = process.argv.slice(2);
const { error } = await supabase
  .from("tiktok_publish_jobs")
  .update({ status: "COMPLETED", publish_id: postId ?? null, tiktok_post_id: url ?? null, completed_at: new Date().toISOString() })
  .eq("id", jobId!);
console.log(error ? `errore: ${error.message}` : "segnato completato");
