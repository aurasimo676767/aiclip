import fs from "node:fs";
import { google } from "googleapis";
import type { YoutubePrivacyStatus } from "@clipforge/db";

export interface YoutubeCredentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  /** ms epoch di scadenza dell'access token: senza questo, google-auth-library non sa che è scaduto e non lo rinnova da solo prima della chiamata. */
  expiryDate: number;
}

export interface YoutubeUploadParams {
  credentials: YoutubeCredentials;
  filePath: string;
  title: string;
  description: string;
  tags: string[];
  privacyStatus: YoutubePrivacyStatus;
  /** ISO 8601. Se presente, il video viene caricato subito ma reso pubblico da YouTube stessa a quest'ora — non serve nessuno scheduler nostro. YouTube richiede privacyStatus "private" quando publishAt è impostato. */
  publishAt?: string | null;
  /** Determina solo l'URL restituito (/shorts/ vs /watch): un long-form caricato con l'URL da Short funziona per caso via redirect di YouTube, ma non è corretto. */
  videoKind: "short" | "longform";
}

export interface YoutubeUploadResult {
  videoId: string;
  url: string;
  /** Se Google ha rinnovato l'access token durante la chiamata, va persistito per il prossimo upload. */
  refreshedAccessToken?: string;
  refreshedExpiresAt?: string;
}

export interface SetThumbnailParams {
  credentials: YoutubeCredentials;
  videoId: string;
  imagePath: string;
}

export interface SetThumbnailResult {
  refreshedAccessToken?: string;
  refreshedExpiresAt?: string;
}

/**
 * Imposta la miniatura di un video già esistente su YouTube (`thumbnails.set`) — stesso scope
 * OAuth "youtube" già richiesto per l'upload/la cancellazione dei video, nessun nuovo permesso
 * da autorizzare.
 */
export async function setYoutubeThumbnail(params: SetThumbnailParams): Promise<SetThumbnailResult> {
  const { credentials, videoId, imagePath } = params;

  const oauth2Client = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
  oauth2Client.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expiry_date: credentials.expiryDate,
  });

  const youtube = google.youtube({ version: "v3", auth: oauth2Client });
  await youtube.thumbnails.set({ videoId, media: { body: fs.createReadStream(imagePath) } });

  const refreshedCredentials = oauth2Client.credentials;
  return {
    refreshedAccessToken: refreshedCredentials.access_token !== credentials.accessToken ? (refreshedCredentials.access_token ?? undefined) : undefined,
    refreshedExpiresAt: refreshedCredentials.expiry_date ? new Date(refreshedCredentials.expiry_date).toISOString() : undefined,
  };
}

/**
 * Carica un file mp4 renderizzato (Short o long-form) sul canale collegato dell'utente via
 * YouTube Data API v3 (`videos.insert`, upload resumable gestito dalla libreria ufficiale
 * `googleapis`). YouTube riconosce automaticamente un video come Short se verticale/quadrato
 * e di durata contenuta — le nostre clip lo sono già, nessun flag speciale da passare.
 */
export async function uploadVideoToYoutube(params: YoutubeUploadParams): Promise<YoutubeUploadResult> {
  const { credentials, filePath, title, description, tags, privacyStatus, publishAt, videoKind } = params;

  const oauth2Client = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
  oauth2Client.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expiry_date: credentials.expiryDate,
  });

  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  // YouTube richiede privacyStatus "private" quando si passa publishAt (rifiuta "public"/"unlisted"
  // insieme a una data futura) — lo forziamo qui, non ci si può fidare del solo valore in ingresso.
  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: title.slice(0, 100),
        description: description.slice(0, 5000),
        tags: tags.slice(0, 30),
        categoryId: "24", // Entertainment
      },
      status: {
        privacyStatus: publishAt ? "private" : privacyStatus,
        selfDeclaredMadeForKids: false,
        ...(publishAt ? { publishAt } : {}),
      },
    },
    media: {
      body: fs.createReadStream(filePath),
    },
  });

  const videoId = response.data.id;
  if (!videoId) {
    throw new Error("YouTube non ha restituito un id video dopo l'upload");
  }

  const refreshedCredentials = oauth2Client.credentials;

  return {
    videoId,
    url: videoKind === "short" ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
    refreshedAccessToken: refreshedCredentials.access_token !== credentials.accessToken ? (refreshedCredentials.access_token ?? undefined) : undefined,
    refreshedExpiresAt: refreshedCredentials.expiry_date ? new Date(refreshedCredentials.expiry_date).toISOString() : undefined,
  };
}

/**
 * Prova, in ordine di qualità decrescente, gli URL diretti della CDN di YouTube per la copertina
 * di un video — `search.list`/`videos.list` a volte non riportano affatto la variante `maxres`
 * anche quando esiste davvero (osservato in pratica: la vera copertina 1280x720 esisteva,
 * l'endpoint di ricerca però non la elencava mai, solo una versione piccola). Interrogare
 * direttamente la CDN con una HEAD è più affidabile.
 */
export async function fetchBestYoutubeThumbnailUrl(videoId: string): Promise<string | null> {
  const candidates = ["maxresdefault", "sddefault", "hqdefault"];
  for (const name of candidates) {
    const url = `https://i.ytimg.com/vi/${videoId}/${name}.jpg`;
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok) return url;
    } catch {
      // prova la prossima variante
    }
  }
  return null;
}

/**
 * Cerca su YouTube il video più probabile per una query (titolo/canale letti dall'IA su un
 * fotogramma del video reagito) e ritorna l'URL della SUA copertina ufficiale alla massima
 * risoluzione disponibile — invece di uno screenshot improvvisato del nostro stesso video
 * (spesso con interfaccia/chat visibile). Stesso scope OAuth "youtube" già usato per
 * pubblicare/impostare copertine, nessun permesso nuovo.
 */
export async function findYoutubeThumbnailUrlBySearch(credentials: YoutubeCredentials, query: string): Promise<string | null> {
  const oauth2Client = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
  oauth2Client.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expiry_date: credentials.expiryDate,
  });

  const youtube = google.youtube({ version: "v3", auth: oauth2Client });
  const response = await youtube.search.list({
    part: ["snippet"],
    q: query,
    type: ["video"],
    maxResults: 1,
  });

  const videoId = response.data.items?.[0]?.id?.videoId;
  if (!videoId) return null;
  return fetchBestYoutubeThumbnailUrl(videoId);
}
