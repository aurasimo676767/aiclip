import "dotenv/config";
import fs from "node:fs";
import { google } from "googleapis";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";

/**
 * Titoli e descrizioni VERI degli Shorts italiani più visti di una nicchia (per studiare come
 * scrivono). Uso: tsx src/dev/yt-niche-titles.ts <out.json> "query 1" "query 2" ...
 * Ogni ricerca costa 100 unità della quota giornaliera gratuita (10.000).
 */
const [out, ...queries] = process.argv.slice(2);
const { data: conn } = await supabase.from("youtube_connections").select("*").limit(1).single();
const auth = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
auth.setCredentials({ access_token: conn!.access_token, refresh_token: conn!.refresh_token, expiry_date: new Date(conn!.expires_at).getTime() });
const yt = google.youtube({ version: "v3", auth });

const ids = new Set<string>();
for (const q of queries) {
  for (const order of ["viewCount", "relevance"] as const) {
    const r = await yt.search.list({
      part: ["id"],
      q,
      type: ["video"],
      videoDuration: "short",
      relevanceLanguage: "it",
      regionCode: "IT",
      order,
      publishedAfter: new Date(Date.now() - 180 * 86400000).toISOString(),
      maxResults: 50,
    });
    for (const it of r.data.items ?? []) if (it.id?.videoId) ids.add(it.id.videoId);
  }
}
const videos: Record<string, unknown>[] = [];
const list = [...ids];
for (let i = 0; i < list.length; i += 50) {
  const r = await yt.videos.list({ part: ["snippet", "statistics", "contentDetails"], id: list.slice(i, i + 50) });
  for (const v of r.data.items ?? []) {
    videos.push({
      id: v.id,
      channel: v.snippet?.channelTitle,
      title: v.snippet?.title,
      description: v.snippet?.description,
      tags: v.snippet?.tags ?? [],
      lang: v.snippet?.defaultAudioLanguage ?? v.snippet?.defaultLanguage,
      views: Number(v.statistics?.viewCount ?? 0),
      likes: Number(v.statistics?.likeCount ?? 0),
      publishedAt: v.snippet?.publishedAt,
      duration: v.contentDetails?.duration,
    });
  }
}
videos.sort((a, b) => (b.views as number) - (a.views as number));
fs.writeFileSync(out!, JSON.stringify(videos, null, 1));
console.log(`${videos.length} Shorts → ${out}`);
