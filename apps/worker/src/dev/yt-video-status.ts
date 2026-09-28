import "dotenv/config";
import { google } from "googleapis";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";

/**
 * Stato reale di video YouTube del canale collegato: privacy, programmazione, elaborazione, rifiuti,
 * restrizioni e statistiche. Per capire perché un video non prende visualizzazioni.
 * Uso: tsx src/dev/yt-video-status.ts <videoId> [videoId...]
 */
const { data: conn } = await supabase.from("youtube_connections").select("*").limit(1).single();
const auth = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
auth.setCredentials({ access_token: conn!.access_token, refresh_token: conn!.refresh_token, expiry_date: new Date(conn!.expires_at).getTime() });
const yt = google.youtube({ version: "v3", auth });
const res = await yt.videos.list({ part: ["status", "statistics", "contentDetails", "snippet"], id: process.argv.slice(2) });
for (const v of res.data.items ?? []) {
  console.log(
    JSON.stringify({
      id: v.id,
      titolo: v.snippet?.title,
      pubblicatoIl: v.snippet?.publishedAt,
      privacy: v.status?.privacyStatus,
      programmatoPer: v.status?.publishAt,
      caricamento: v.status?.uploadStatus,
      rifiuto: v.status?.rejectionReason,
      fallimento: v.status?.failureReason,
      perBambini: v.status?.madeForKids,
      embeddable: v.status?.embeddable,
      durata: v.contentDetails?.duration,
      restrizioniRegione: v.contentDetails?.regionRestriction,
      rating: v.contentDetails?.contentRating,
      licenza: v.contentDetails?.licensedContent,
      views: v.statistics?.viewCount,
      like: v.statistics?.likeCount,
    }),
  );
}
