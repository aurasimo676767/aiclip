import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Verifica che le colonne esistano sulla tabella. Uso: tsx src/dev/check-columns.ts <tabella> <colonna,colonna> */
const [table, cols] = process.argv.slice(2);
const { error } = await supabase.from(table!).select(cols!).limit(1);
console.log(error ? `MANCA: ${error.message}` : "ok, colonne presenti");
