import "server-only";
import { createServiceRoleClient } from "@clipforge/db";

/**
 * Client Supabase con la service role key: bypassa la RLS.
 * `import "server-only"` fa fallire la build se questo modulo finisse per essere
 * importato (anche transitivamente) da codice bundlato per il browser.
 * Uso consentito SOLO per operazioni che richiedono privilegi elevati e non
 * esprimibili tramite RLS (mint di signed URL per Supabase Storage).
 */
export function createSupabaseAdminClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY mancanti nell'ambiente server");
  }
  return createServiceRoleClient({ url, serviceRoleKey });
}
