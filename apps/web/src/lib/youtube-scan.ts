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
  thumbnailUrl: string;
}

interface YoutubePlaylistItemsResponse {
  items?: Array<{
    snippet?: {
      title?: string;
      publishedAt?: string;
      resourceId?: { videoId?: string };
      thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
    };
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
      thumbnailUrl: item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url ?? "",
    }))
    .filter((v) => v.videoId);
}

interface YoutubeVideosStatsResponse {
  items?: Array<{ id: string; statistics?: { viewCount?: string } }>;
}

/** Conteggio visualizzazioni per un elenco di video (in blocchi da 50, limite dell'API). */
export async function fetchVideoViewCounts(videoIds: string[], accessToken: string): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  const CHUNK_SIZE = 50;

  for (let i = 0; i < videoIds.length; i += CHUNK_SIZE) {
    const chunk = videoIds.slice(i, i + CHUNK_SIZE);
    if (chunk.length === 0) continue;

    const params = new URLSearchParams({ part: "statistics", id: chunk.join(",") });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as YoutubeVideosStatsResponse;
    if (!res.ok) {
      throw new Error("Lettura statistiche video fallita");
    }
    for (const item of data.items ?? []) {
      const raw = item.statistics?.viewCount;
      result.set(item.id, raw ? Number(raw) : null);
    }
  }

  return result;
}

/**
 * Tra un elenco di ID video, ritorna solo quelli che esistono ANCORA su YouTube. Serve a
 * "guarire" job di pubblicazione la cui riga in DB dice ancora "programmato"/"pubblicato" ma
 * il video è stato eliminato a mano da YouTube Studio (il sito non riceve nessun webhook da
 * YouTube per queste cancellazioni dirette, quindi altrimenti resterebbe disallineato per
 * sempre — es. bloccando per errore la coda di auto-programmazione su slot in realtà liberi).
 */
export async function filterExistingYoutubeVideoIds(videoIds: string[], accessToken: string): Promise<Set<string>> {
  const result = new Set<string>();
  const CHUNK_SIZE = 50;

  for (let i = 0; i < videoIds.length; i += CHUNK_SIZE) {
    const chunk = videoIds.slice(i, i + CHUNK_SIZE);
    if (chunk.length === 0) continue;

    const params = new URLSearchParams({ part: "id", id: chunk.join(",") });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as YoutubeVideosStatsResponse;
    if (!res.ok) {
      throw new Error("Verifica video su YouTube fallita");
    }
    for (const item of data.items ?? []) {
      result.add(item.id);
    }
  }

  return result;
}
