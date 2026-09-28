import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TIKTOK_API, tiktokCredentials } from "@/lib/tiktok";

/** Scollega TikTok: revoca l'accesso lato TikTok e cancella i token salvati. */
export async function POST() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });

  const { data: conn } = await supabase.from("tiktok_connections").select("access_token").eq("user_id", user.id).maybeSingle();
  const creds = tiktokCredentials();
  if (conn && creds) {
    // Se la revoca fallisce (token già scaduto) si cancella comunque il collegamento.
    await fetch(`${TIKTOK_API}/oauth/revoke/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_key: creds.clientKey, client_secret: creds.clientSecret, token: conn.access_token }),
    }).catch(() => undefined);
  }
  const { error } = await supabase.from("tiktok_connections").delete().eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
