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
});
