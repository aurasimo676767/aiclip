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
