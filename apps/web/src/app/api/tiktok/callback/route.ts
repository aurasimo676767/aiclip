import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TIKTOK_API, tiktokCredentials, tiktokTokenRequest } from "@/lib/tiktok";

/** Ritorno da TikTok dopo il consenso: scambia il code per i token e salva il collegamento. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const settingsUrl = new URL("/dashboard/settings", request.url);
  const fail = (message: string) => {
    settingsUrl.searchParams.set("tiktok_error", message);
    return NextResponse.redirect(settingsUrl);
  };

  const code = url.searchParams.get("code");
  if (!code) return fail(url.searchParams.get("error_description") ?? "Autorizzazione annullata");
  const expectedState = cookies().get("tiktok_oauth_state")?.value;
  if (!expectedState || expectedState !== url.searchParams.get("state")) return fail("Richiesta non valida, riprova a collegare");

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const creds = tiktokCredentials();
  if (!creds) return fail("Configurazione TikTok mancante lato server");

  try {
    const tokens = await tiktokTokenRequest({
      client_key: creds.clientKey,
      client_secret: creds.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: new URL("/api/tiktok/callback", request.url).toString(),
    });
    if (!tokens.access_token || !tokens.refresh_token || !tokens.open_id) {
      throw new Error(tokens.error_description ?? tokens.error ?? "Scambio token fallito");
    }

    const infoRes = await fetch(`${TIKTOK_API}/user/info/?fields=open_id,avatar_url,display_name`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const info = (await infoRes.json()) as { data?: { user?: { display_name?: string; avatar_url?: string } } };

    const { error } = await supabase.from("tiktok_connections").upsert(
      {
        user_id: user.id,
        open_id: tokens.open_id,
        display_name: info.data?.user?.display_name ?? "",
        avatar_url: info.data?.user?.avatar_url ?? null,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: new Date(Date.now() + (tokens.expires_in ?? 86400) * 1000).toISOString(),
        refresh_expires_at: tokens.refresh_expires_in ? new Date(Date.now() + tokens.refresh_expires_in * 1000).toISOString() : null,
        scope: tokens.scope ?? "",
      },
      { onConflict: "user_id" },
    );
    if (error) {
      throw new Error(error.message.includes("tiktok_connections") ? "Manca la tabella: lancia la migrazione 0030 su Supabase" : error.message);
    }

    settingsUrl.searchParams.set("tiktok_connected", "1");
    const res = NextResponse.redirect(settingsUrl);
    res.cookies.delete("tiktok_oauth_state");
    return res;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
