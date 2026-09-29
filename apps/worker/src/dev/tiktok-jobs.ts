import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Ultimi invii a TikTok con stato ed errore. Uso: tsx src/dev/tiktok-jobs.ts */
const { data } = await supabase.from("tiktok_publish_jobs").select("id,status,error_message,claimed_at,attempts,created_at,completed_at,publish_id").order("created_at", { ascending: false }).limit(3);
for (const j of data ?? []) console.log(JSON.stringify(j));
