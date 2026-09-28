import type { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * TikTok (Login Kit + Content Posting API) lato server. Le chiavi stanno solo nelle variabili
 * d'ambiente (TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET): quelle del Sandbox finché TikTok non approva
 * l'app, poi quelle di produzione.
 */

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

// Solo quelli usati davvero (TikTok in revisione chiede di togliere gli altri): profilo + Direct Post.
export const TIKTOK_SCOPES = ["user.info.basic", "video.publish"];
export const TIKTOK_API = "https://open.tiktokapis.com/v2";

export function tiktokCredentials(): { clientKey: string; clientSecret: string } | null {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  return clientKey && clientSecret ? { clientKey, clientSecret } : null;
}

export interface TiktokTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  open_id?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export async function tiktokTokenRequest(body: Record<string, string>): Promise<TiktokTokenResponse> {
  const res = await fetch(`${TIKTOK_API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams(body),
  });
  return (await res.json()) as TiktokTokenResponse;
}

/**
 * Token valido dell'utente, rinnovato se sta per scadere (dura 24 ore; il refresh token un anno).
 * null se l'utente non ha collegato TikTok.
 */
export async function tiktokAccessToken(supabase: SupabaseServerClient, userId: string): Promise<string | null> {
  const { data: conn } = await supabase.from("tiktok_connections").select("access_token, refresh_token, expires_at").eq("user_id", userId).maybeSingle();
  if (!conn) return null;
  if (new Date(conn.expires_at).getTime() - Date.now() > 5 * 60 * 1000) return conn.access_token;
  const creds = tiktokCredentials();
  if (!creds) throw new Error("Chiavi TikTok mancanti lato server");
  const tokens = await tiktokTokenRequest({
    client_key: creds.clientKey,
    client_secret: creds.clientSecret,
    grant_type: "refresh_token",
    refresh_token: conn.refresh_token,
  });
  if (!tokens.access_token) throw new Error(tokens.error_description ?? tokens.error ?? "Rinnovo del token TikTok fallito: ricollega l'account");
  await supabase
    .from("tiktok_connections")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? conn.refresh_token,
      expires_at: new Date(Date.now() + (tokens.expires_in ?? 86400) * 1000).toISOString(),
      ...(tokens.refresh_expires_in ? { refresh_expires_at: new Date(Date.now() + tokens.refresh_expires_in * 1000).toISOString() } : {}),
    })
    .eq("user_id", userId);
  return tokens.access_token;
}

export interface TiktokCreatorInfo {
  creator_avatar_url: string;
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
}

/** Info del creator da mostrare PRIMA di pubblicare (obbligatorio per le regole della Content Posting API). */
export async function tiktokCreatorInfo(accessToken: string): Promise<TiktokCreatorInfo> {
  const res = await fetch(`${TIKTOK_API}/post/publish/creator_info/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
  });
  const json = (await res.json()) as { data?: TiktokCreatorInfo; error?: { code: string; message: string } };
  if (!res.ok || !json.data || (json.error && json.error.code !== "ok")) {
    throw new Error(json.error?.message || `creator_info fallita (${res.status})`);
  }
  return json.data;
}
