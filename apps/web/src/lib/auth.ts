import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "./supabase/server";

/** Da usare in cima ai Server Component sotto /dashboard: garantisce una sessione valida. */
export async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return { supabase, user };
}
