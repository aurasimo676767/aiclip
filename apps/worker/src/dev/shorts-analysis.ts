import "dotenv/config";
import fs from "node:fs";
import { google } from "googleapis";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";

/**
 * Tutti gli Shorts del canale con statistiche e analytics a vita (views, views coinvolte,
 * % vista media, like, condivisioni, iscritti) + dati della clip ClipForge se c'è.
 * Uso: tsx src/dev/shorts-analysis.ts <file-output.json>
 */
const out = process.argv[2] ?? "shorts-analysis.json";
const { data: conn } = await supabase.from("youtube_connections").select("*").limit(1).single();
const auth = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
auth.setCredentials({ access_token: conn!.access_token, refresh_token: conn!.refresh_token, expiry_date: new Date(conn!.expires_at).getTime() });
const yt = google.youtube({ version: "v3", auth });
const ya = google.youtubeAnalytics({ version: "v2", auth });

const ch = await yt.channels.list({ part: ["contentDetails", "snippet", "statistics"], mine: true });
const channel = ch.data.items![0]!;
const uploads = channel.contentDetails!.relatedPlaylists!.uploads!;
const ids: string[] = [];
let pageToken: string | undefined;
do {
  const r = await yt.playlistItems.list({ part: ["contentDetails"], playlistId: uploads, maxResults: 50, pageToken });
  for (const it of r.data.items ?? []) ids.push(it.contentDetails!.videoId!);
  pageToken = r.data.nextPageToken ?? undefined;
} while (pageToken);

const secs = (iso: string) => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso) ?? [];
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
};
const videos: Record<string, unknown>[] = [];
for (let i = 0; i < ids.length; i += 50) {
  const r = await yt.videos.list({ part: ["snippet", "statistics", "contentDetails", "status"], id: ids.slice(i, i + 50) });
  for (const v of r.data.items ?? []) {
    if (v.status?.privacyStatus !== "public") continue;
    videos.push({
      id: v.id,
      title: v.snippet?.title,
      publishedAt: v.snippet?.publishedAt,
      duration: secs(v.contentDetails?.duration ?? ""),
      views: Number(v.statistics?.viewCount ?? 0),
      likes: Number(v.statistics?.likeCount ?? 0),
      comments: Number(v.statistics?.commentCount ?? 0),
      tags: v.snippet?.tags ?? [],
      description: v.snippet?.description,
    });
  }
}

const start = "2020-01-01";
const end = new Date().toISOString().slice(0, 10);
for (const v of videos) {
  try {
    const r = await ya.reports.query({
      ids: "channel==MINE",
      startDate: start,
      endDate: end,
      metrics: "views,engagedViews,averageViewDuration,averageViewPercentage,likes,shares,subscribersGained",
      filters: `video==${v.id}`,
    });
    const row = r.data.rows?.[0] ?? [];
    const names = (r.data.columnHeaders ?? []).map((h) => h.name!);
    v.analytics = Object.fromEntries(names.map((n, i) => [n, row[i]]));
    const t = await ya.reports.query({ ids: "channel==MINE", startDate: start, endDate: end, metrics: "views", dimensions: "insightTrafficSourceType", filters: `video==${v.id}` });
    v.traffic = Object.fromEntries((t.data.rows ?? []).map((x) => [x[0], x[1]]));
  } catch (err) {
    v.analyticsError = err instanceof Error ? err.message : String(err);
  }
  const { data: job } = await supabase.from("youtube_publish_jobs").select("clip_id,publish_at,completed_at").eq("youtube_video_id", v.id as string).maybeSingle();
  if (job) {
    const { data: clip } = await supabase.from("clips").select("title,hook,reason,scores,duration,start_time,video_id,editing_style,template,badges,created_at").eq("id", job.clip_id).single();
    const { data: src } = clip ? await supabase.from("videos").select("title,source_url,created_at").eq("id", clip.video_id).single() : { data: null };
    v.clipforge = { ...job, clip, source: src };
  }
}
fs.writeFileSync(out, JSON.stringify({ channel: { title: channel.snippet?.title, stats: channel.statistics }, videos }, null, 1));
console.log(`${videos.length} video pubblici (${videos.filter((v) => (v.duration as number) <= 180).length} Shorts ≤180s) → ${out}`);
