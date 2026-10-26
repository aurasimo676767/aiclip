import { createServiceRoleClient } from "@clipforge/db";
import { env } from "../env.js";

/**
 * Client Supabase condiviso dal worker, con la service role key.
 * Bypassa la RLS: ogni query deve filtrare esplicitamente per l'entità corretta
 * (project/video/clip) — il worker opera su job di tutti gli utenti.
 */
export const supabase = createServiceRoleClient({
  url: env.SUPABASE_URL,
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  // Le query del worker durano meno di un secondo: oltre un minuto la connessione è morta, meglio
  // un errore (il giro riprova da solo) che un giro appeso per sempre.
  timeoutMs: 60_000,
});
