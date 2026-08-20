"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@clipforge/db";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env";

/**
 * Client Supabase per i Client Component (browser). Usa solo anon key + sessione utente:
 * rispetta sempre la RLS. Vedi il commento in server.ts sul cast: è lo stesso workaround
 * per l'inferenza di tipo rotta di @supabase/ssr.
 */
export function createSupabaseBrowserClient() {
  const client = createBrowserClient(getSupabaseUrl(), getSupabaseAnonKey());
  return client as unknown as SupabaseClient<Database>;
}
