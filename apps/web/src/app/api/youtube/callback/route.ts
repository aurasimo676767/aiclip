import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  error?: string;
  error_description?: string;
}

interface YoutubeChannelListResponse {
  items?: Array<{ id: string; snippet?: { title?: string } }>;
}

/** Riceve il redirect di Google dopo il consenso, scambia il code per i token e salva la connessione. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const settingsUrl = new URL("/dashboard/settings", request.url);

  if (!code) {
    settingsUrl.searchParams.set("youtube_error", "Autorizzazione annullata o mancante");
    return NextResponse.redirect(settingsUrl);
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    settingsUrl.searchParams.set("youtube_error", "Configurazione Google mancante lato server");
    return NextResponse.redirect(settingsUrl);
  }

  const redirectUri = new URL("/api/youtube/callback", request.url).toString();

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokens = (await tokenRes.json()) as GoogleTokenResponse;
    if (!tokenRes.ok || !tokens.access_token) {
      throw new Error(tokens.error_description ?? tokens.error ?? "Scambio token fallito");
    }
    if (!tokens.refresh_token) {
      // Capita se l'utente aveva già autorizzato l'app senza revocare l'accesso prima: senza
      // refresh_token non possiamo rinnovare l'accesso più avanti.
      throw new Error("Google non ha restituito un refresh token. Rivoca l'accesso all'app dal tuo account Google e riprova.");
    }

    const channelRes = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const channelData = (await channelRes.json()) as YoutubeChannelListResponse;
    const channel = channelData.items?.[0];

    const { error: upsertError } = await supabase.from("youtube_connections").upsert(
      {
        user_id: user.id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        channel_id: channel?.id ?? "",
        channel_title: channel?.snippet?.title ?? "Canale YouTube",
        scope: tokens.scope,
      },
      { onConflict: "user_id" },
    );
    if (upsertError) {
      throw new Error(upsertError.message);
    }

    settingsUrl.searchParams.set("youtube_connected", "1");
    return NextResponse.redirect(settingsUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    settingsUrl.searchParams.set("youtube_error", message);
    return NextResponse.redirect(settingsUrl);
  }
}
