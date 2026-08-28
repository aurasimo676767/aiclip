import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "./supabase/server";

/**
 * Da usare in cima ai Server Component sotto /dashboard: garantisce una sessione valida.
 * Sia il layout che ogni singola pagina la chiamano (per avere `user`/`supabase` a portata di
 * mano ovunque) — senza `cache()` questo significa DUE round-trip di rete verso l'auth di
 * Supabase per ogni navigazione (uno dal layout, uno dalla pagina), che si sentiva su ogni
 * click. `cache()` di React memoizza il risultato per la durata di UNA richiesta: la seconda
 * chiamata nello stesso render riusa il risultato già ottenuto invece di rifare la chiamata.
 */
export const requireUser = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return { supabase, user };
});
