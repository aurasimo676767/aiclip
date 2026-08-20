import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@clipforge/db";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env";

/**
 * Client Supabase per Server Component / Route Handler, legato alla sessione utente
 * tramite i cookie della richiesta. Usa solo anon key: la RLS resta sempre attiva,
 * ogni query è automaticamente scoped all'utente autenticato (auth.uid()).
 *
 * Nota sul cast finale: `createServerClient` di @supabase/ssr ricalcola da sé il tipo
 * `Schema` a partire da `Database` invece di derivarlo come fa `SupabaseClient`, e quel
 * calcolo risolve in modo scorretto (ogni query finirebbe per essere tipizzata `never`).
 * Passiamo quindi `Database` esplicitamente solo a `SupabaseClient` (la cui inferenza è
 * corretta, verificato) e trattiamo `createServerClient` come untyped a monte.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  const client = createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // In un Server Component (non in una Route Handler/Server Action) i cookie
          // sono read-only: l'eventuale refresh del token viene comunque gestito dal
          // middleware ad ogni richiesta, quindi qui è sicuro ignorare l'errore.
        }
      },
    },
  });

  return client as unknown as SupabaseClient<Database>;
}
