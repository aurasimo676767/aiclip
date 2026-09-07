// Twitch, a differenza di YouTube, non richiede un OAuth per-utente per leggere canali/VOD
// pubblici: basta un "app access token" server-to-server (Client Credentials Grant) ottenuto
// con TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET — nessun pulsante "Connetti Twitch", nessun token da
// rinnovare per utente. Il token viene richiesto fresco a ogni chiamata (volumi bassi, nessun
// bisogno reale di cache, ed evitiamo bug di invalidazione su funzioni serverless stateless).

interface TwitchTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

async function getTwitchAppAccessToken(): Promise<string> {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Configurazione Twitch mancante lato server (TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET)");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://id.twitch.tv/oauth2/token?${params.toString()}`, { method: "POST" });
  const data = (await res.json()) as TwitchTokenResponse & { message?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(data.message ?? "Autenticazione Twitch fallita");
  }
  return data.access_token;
}

export interface ResolvedTwitchChannel {
  twitchUserId: string;
  login: string;
  displayName: string;
}

interface TwitchUsersResponse {
  data?: Array<{ id: string; login: string; display_name: string }>;
}

/** Risolve un login/handle Twitch (o un URL twitch.tv/nome) in ID + nome visualizzato. */
export async function resolveTwitchChannel(input: string): Promise<ResolvedTwitchChannel> {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) {
    throw new Error("Configurazione Twitch mancante lato server (TWITCH_CLIENT_ID)");
  }

  const login = parseTwitchLogin(input);
  if (!login) {
    throw new Error("Non riesco a interpretare questo canale — incolla il link completo (es. twitch.tv/nomecanale) o solo il nome");
  }

  const accessToken = await getTwitchAppAccessToken();
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
    headers: { "Client-Id": clientId, Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as TwitchUsersResponse;
  const user = data.data?.[0];
  if (!res.ok || !user) {
    throw new Error("Canale Twitch non trovato — controlla il nome");
  }

  return { twitchUserId: user.id, login: user.login, displayName: user.display_name };
}

function parseTwitchLogin(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/(?:twitch\.tv\/)([A-Za-z0-9_]+)/i);
  if (urlMatch?.[1]) return urlMatch[1].toLowerCase();
  if (/^[A-Za-z0-9_]+$/.test(trimmed)) return trimmed.toLowerCase();
  return null;
}

export interface TwitchVod {
  vodId: string;
  title: string;
  url: string;
  thumbnailUrl: string;
  createdAt: string;
  durationSeconds: number;
}

interface TwitchVideosResponse {
  data?: Array<{
    id: string;
    title: string;
    url: string;
    thumbnail_url: string;
    created_at: string;
    duration: string; // es. "3h24m10s" oppure "45m2s" oppure "58s"
  }>;
  pagination?: { cursor?: string };
}

function mapTwitchVideos(data: TwitchVideosResponse): TwitchVod[] {
  return (data.data ?? []).map((v) => ({
    vodId: v.id,
    title: v.title,
    url: v.url,
    // Il template ha {width}x{height} letterali da sostituire con una risoluzione reale.
    thumbnailUrl: v.thumbnail_url.replace("{width}", "440").replace("{height}", "248"),
    createdAt: v.created_at,
    durationSeconds: parseTwitchDuration(v.duration),
  }));
}

/** Gli ultimi `maxResults` VOD (type=archive, esclude highlight/clip caricati) di un canale. */
export async function fetchLatestVods(twitchUserId: string, maxResults: number): Promise<TwitchVod[]> {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) {
    throw new Error("Configurazione Twitch mancante lato server (TWITCH_CLIENT_ID)");
  }

  const accessToken = await getTwitchAppAccessToken();
  const params = new URLSearchParams({ user_id: twitchUserId, type: "archive", first: String(maxResults) });
  const res = await fetch(`https://api.twitch.tv/helix/videos?${params.toString()}`, {
    headers: { "Client-Id": clientId, Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as TwitchVideosResponse;
  if (!res.ok) {
    throw new Error("Lettura VOD del canale fallita");
  }

  return mapTwitchVideos(data);
}

const HELIX_MAX_PAGE_SIZE = 100;
// Twitch tiene i VOD per ~60 giorni (più per i partner): con VOD tipicamente non giornalieri,
// 5 pagine da 100 (500 VOD) coprono ampiamente qualunque canale prima che l'API smetta di
// restituire risultati da sola — un limite di sicurezza contro un loop, non un vincolo reale.
const MAX_PAGES = 5;

/**
 * TUTTI i VOD disponibili di un canale (non solo gli ultimi N) — pagina l'API Helix con `after`
 * finché non ci sono più risultati. Usato dalla pagina "tutti i VOD di questo canale", per poter
 * generare in blocco l'intero storico ancora disponibile (limitato dalla retention di Twitch
 * stessa, ~2 mesi), invece di doverli aprire uno alla volta dal feed misto.
 */
export async function fetchAllVods(twitchUserId: string): Promise<TwitchVod[]> {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) {
    throw new Error("Configurazione Twitch mancante lato server (TWITCH_CLIENT_ID)");
  }

  const accessToken = await getTwitchAppAccessToken();
  const allVods: TwitchVod[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ user_id: twitchUserId, type: "archive", first: String(HELIX_MAX_PAGE_SIZE) });
    if (cursor) params.set("after", cursor);

    const res = await fetch(`https://api.twitch.tv/helix/videos?${params.toString()}`, {
      headers: { "Client-Id": clientId, Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as TwitchVideosResponse;
    if (!res.ok) {
      throw new Error("Lettura VOD del canale fallita");
    }

    allVods.push(...mapTwitchVideos(data));

    cursor = data.pagination?.cursor;
    if (!cursor || (data.data?.length ?? 0) === 0) break;
  }

  return allVods;
}

/** Converte il formato durata di Twitch ("3h24m10s", "45m2s", "58s") in secondi. */
function parseTwitchDuration(duration: string): number {
  const match = duration.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!match) return 0;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}
