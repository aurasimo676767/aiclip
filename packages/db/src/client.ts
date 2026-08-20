import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.js";

// Interface (non `type`) di proposito: un `type` alias su un'istanziazione generica come
// `SupabaseClient<Database>` resta "non valutato" quando consumato da un altro package del
// monorepo, e rompe silenziosamente l'inferenza dei metodi (.update()/.rpc() risolvono a
// `never`). Un'interfaccia che estende lo stesso tipo forza TypeScript a valutarlo subito.
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ServiceRoleClient extends SupabaseClient<Database> {}

/**
 * Client Supabase con la service role key: bypassa la RLS.
 * Uso esclusivamente server-side (worker, route handler server-only) — non deve mai
 * raggiungere il browser. Chi la usa è responsabile di applicare i controlli di
 * autorizzazione a mano (es. verificare che il project.user_id combaci con l'utente).
 */
export function createServiceRoleClient(config: { url: string; serviceRoleKey: string }): ServiceRoleClient {
  if (!config.url || !config.serviceRoleKey) {
    throw new Error("createServiceRoleClient: url e serviceRoleKey sono obbligatori");
  }

  return createClient<Database>(config.url, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
