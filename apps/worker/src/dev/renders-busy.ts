import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Stampa quante clip sono in render o in coda (tutti i video). Uso: tsx src/dev/renders-busy.ts */
const { count } = await supabase.from("clips").select("id", { count: "exact", head: true }).in("status", ["QUEUED", "RENDERING"]);
console.log(count ?? -1);
