import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, YoutubeConnectionRow } from "@clipforge/db";

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

/**
 * Ritorna un access token valido per l'account YouTube collegato, rinnovandolo se scaduto
 * (stessa idea del rinnovo automatico lato worker, ma qui via fetch diretto: il web non ha
 * google-auth-library, solo chiamate REST semplici — coerente con lo stile già usato in
 * apps/web/src/app/api/youtube/callback/route.ts).
 */
export async function getValidYoutubeAccessToken(
  supabase: SupabaseClient<Database>,
  connection: YoutubeConnectionRow,
): Promise<string> {
  const expiresInMs = new Date(connection.expires_at).getTime() - Date.now();
  if (expiresInMs > 60_000) {
    return connection.access_token;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Configurazione Google mancante lato server");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tokens = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || !tokens.access_token) {
    throw new Error(tokens.error_description ?? tokens.error ?? "Rinnovo token YouTube fallito");
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  await supabase.from("youtube_connections").update({ access_token: tokens.access_token, expires_at: expiresAt }).eq("id", connection.id);

  return tokens.access_token;
}

interface YoutubeChannelListResponse {
  items?: Array<{
    id: string;
    snippet?: { title?: string };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }>;
}

export interface ResolvedChannel {
  channelId: string;
  channelTitle: string;
  uploadsPlaylistId: string;
}

/** Estrae un handle (@nome) o un ID canale (UCxxxx) da un URL o input libero. */
function parseChannelInput(input: string): { handle?: string; channelId?: string } {
  const trimmed = input.trim();

  const channelIdMatch = trimmed.match(/(?:youtube\.com\/channel\/)?(UC[A-Za-z0-9_-]{22})/);
  if (channelIdMatch?.[1]) return { channelId: channelIdMatch[1] };

  const handleMatch = trimmed.match(/(?:youtube\.com\/)?@([A-Za-z0-9_.-]+)/);
  if (handleMatch?.[1]) return { handle: handleMatch[1] };

  // Input libero senza @ né URL: prova come handle diretto.
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) return { handle: trimmed };

  return {};
}

/** Risolve un URL/handle canale in ID + titolo + playlist "uploads" (serve una volta sola, salvata poi in followed_channels). */
export async function resolveYoutubeChannel(input: string, accessToken: string): Promise<ResolvedChannel> {
  const { handle, channelId } = parseChannelInput(input);
  if (!handle && !channelId) {
    throw new Error("Non riesco a interpretare questo canale — incolla il link completo (es. youtube.com/@nomecanale)");
  }

  const params = new URLSearchParams({ part: "snippet,contentDetails" });
  if (channelId) params.set("id", channelId);
  else params.set("forHandle", `@${handle}`);

  const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as YoutubeChannelListResponse;
  const item = data.items?.[0];
  const uploadsPlaylistId = item?.contentDetails?.relatedPlaylists?.uploads;
  if (!res.ok || !item || !uploadsPlaylistId) {
    throw new Error("Canale non trovato — controlla il link");
  }

  return { channelId: item.id, channelTitle: item.snippet?.title ?? "Canale YouTube", uploadsPlaylistId };
}

export interface ChannelUploadVideo {
  videoId: string;
  title: string;
  publishedAt: string;
}

interface YoutubePlaylistItemsResponse {
  items?: Array<{
    snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } };
  }>;
}

/** Gli ultimi `maxResults` video caricati su un canale (dalla sua playlist "uploads"). */
export async function fetchLatestUploads(uploadsPlaylistId: string, accessToken: string, maxResults: number): Promise<ChannelUploadVideo[]> {
  const params = new URLSearchParams({ part: "snippet", playlistId: uploadsPlaylistId, maxResults: String(maxResults) });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as YoutubePlaylistItemsResponse;
  if (!res.ok) {
    throw new Error("Lettura video del canale fallita");
  }

  return (data.items ?? [])
    .map((item) => ({
      videoId: item.snippet?.resourceId?.videoId ?? "",
      title: item.snippet?.title ?? "",
      publishedAt: item.snippet?.publishedAt ?? "",
    }))
    .filter((v) => v.videoId);
}
