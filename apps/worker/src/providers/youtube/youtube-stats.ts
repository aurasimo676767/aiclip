import { google } from "googleapis";

export interface YoutubeStatsCredentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
}

export interface YoutubeVideoStats {
  videoId: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
}

const MAX_IDS_PER_CALL = 50; // limite di videos.list

/**
 * Recupera le statistiche pubbliche (views/like/commenti) per fino a 50 video alla volta,
 * via l'account YouTube collegato del proprietario dei video — usato dal refresh periodico
 * (vedi refresh-youtube-stats.ts), non dal flusso di upload.
 */
export async function fetchYoutubeVideoStats(
  credentials: YoutubeStatsCredentials,
  videoIds: string[],
): Promise<{ stats: YoutubeVideoStats[]; refreshedAccessToken?: string; refreshedExpiresAt?: string }> {
  const oauth2Client = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
  oauth2Client.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expiry_date: credentials.expiryDate,
  });

  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  const stats: YoutubeVideoStats[] = [];
  for (let i = 0; i < videoIds.length; i += MAX_IDS_PER_CALL) {
    const chunk = videoIds.slice(i, i + MAX_IDS_PER_CALL);
    const response = await youtube.videos.list({ part: ["statistics"], id: chunk });
    for (const item of response.data.items ?? []) {
      if (!item.id) continue;
      stats.push({
        videoId: item.id,
        viewCount: item.statistics?.viewCount ? Number(item.statistics.viewCount) : null,
        likeCount: item.statistics?.likeCount ? Number(item.statistics.likeCount) : null,
        commentCount: item.statistics?.commentCount ? Number(item.statistics.commentCount) : null,
      });
    }
  }

  const refreshedCredentials = oauth2Client.credentials;
  return {
    stats,
    refreshedAccessToken: refreshedCredentials.access_token !== credentials.accessToken ? (refreshedCredentials.access_token ?? undefined) : undefined,
    refreshedExpiresAt: refreshedCredentials.expiry_date ? new Date(refreshedCredentials.expiry_date).toISOString() : undefined,
  };
}

export interface YoutubeVideoAnalytics {
  videoId: string;
  views: number;
  /** Visualizzazioni "engaged" (la vecchia definizione di view): engaged/views ≈ "ha continuato a guardare" di Studio. */
  engagedViews: number;
  averageViewDuration: number;
  averageViewPercentage: number;
  shares: number;
  subscribersGained: number;
}

const MAX_IDS_PER_ANALYTICS_CALL = 200;

/**
 * Statistiche complete dall'API YouTube Analytics (tenuta, engaged, condivisioni, iscritti) per
 * i video del canale collegato, dalla pubblicazione a oggi. Serve lo scope yt-analytics.readonly:
 * senza, Google risponde "insufficient scopes" e il chiamante lo segnala come "ricollega YouTube".
 * YouTube calcola questi numeri con 1-2 giorni di ritardo.
 */
export async function fetchYoutubeVideoAnalytics(
  credentials: YoutubeStatsCredentials,
  videoIds: string[],
): Promise<YoutubeVideoAnalytics[]> {
  const oauth2Client = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
  oauth2Client.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expiry_date: credentials.expiryDate,
  });
  const analytics = google.youtubeAnalytics({ version: "v2", auth: oauth2Client });
  const today = new Date().toISOString().slice(0, 10);
  const out: YoutubeVideoAnalytics[] = [];
  for (let i = 0; i < videoIds.length; i += MAX_IDS_PER_ANALYTICS_CALL) {
    const chunk = videoIds.slice(i, i + MAX_IDS_PER_ANALYTICS_CALL);
    const response = await analytics.reports.query({
      ids: "channel==MINE",
      startDate: "2020-01-01",
      endDate: today,
      metrics: "views,engagedViews,averageViewDuration,averageViewPercentage,shares,subscribersGained",
      dimensions: "video",
      filters: `video==${chunk.join(",")}`,
      maxResults: chunk.length,
    });
    const headers = (response.data.columnHeaders ?? []).map((h) => h.name ?? "");
    const col = (row: unknown[], name: string) => Number(row[headers.indexOf(name)] ?? 0);
    for (const row of (response.data.rows ?? []) as unknown[][]) {
      out.push({
        videoId: String(row[headers.indexOf("video")]),
        views: col(row, "views"),
        engagedViews: col(row, "engagedViews"),
        averageViewDuration: col(row, "averageViewDuration"),
        averageViewPercentage: col(row, "averageViewPercentage"),
        shares: col(row, "shares"),
        subscribersGained: col(row, "subscribersGained"),
      });
    }
  }
  return out;
}
