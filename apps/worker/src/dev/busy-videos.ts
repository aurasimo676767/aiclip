import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Video in lavorazione (non pronti, non falliti, non in attesa). Uso: tsx src/dev/busy-videos.ts */
const { data } = await supabase.from("videos").select("id,status,updated_at").not("status", "in", "(READY,FAILED,UPLOADED)");
for (const v of data ?? []) console.log(v.status, v.id, v.updated_at);
if (!data?.length) console.log("nessun video in lavorazione");
