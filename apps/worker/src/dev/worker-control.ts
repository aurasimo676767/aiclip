import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Stato del pulsante pausa del sito (worker_control). Uso: tsx src/dev/worker-control.ts */
const { data, error } = await supabase.from("worker_control").select("*").eq("id", true).maybeSingle();
console.log(JSON.stringify(data ?? error));
