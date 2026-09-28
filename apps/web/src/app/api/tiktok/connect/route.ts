import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TIKTOK_SCOPES, tiktokCredentials } from "@/lib/tiktok";

/** Avvia il collegamento dell'account TikTok (Login Kit): reindirizza alla schermata di consenso. */
export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const creds = tiktokCredentials();
  if (!creds) return NextResponse.json({ error: "TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET mancanti nell'ambiente server" }, { status: 500 });

  // state contro le richieste forgiate: lo stesso valore deve tornare nel callback.
  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_key: creds.clientKey,
    scope: TIKTOK_SCOPES.join(","),
    response_type: "code",
    redirect_uri: new URL("/api/tiktok/callback", request.url).toString(),
    state,
  });
  const res = NextResponse.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
  res.cookies.set("tiktok_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
