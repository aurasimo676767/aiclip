import "dotenv/config";
import { google } from "googleapis";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";

/** Curva di permanenza (quanta gente è ancora lì a ogni % del video). Uso: tsx src/dev/shorts-retention.ts <videoId> [...] */
const { data: conn } = await supabase.from("youtube_connections").select("*").limit(1).single();
const auth = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
auth.setCredentials({ access_token: conn!.access_token, refresh_token: conn!.refresh_token, expiry_date: new Date(conn!.expires_at).getTime() });
const ya = google.youtubeAnalytics({ version: "v2", auth });
for (const id of process.argv.slice(2)) {
  const r = await ya.reports.query({
    ids: "channel==MINE",
    startDate: "2020-01-01",
    endDate: new Date().toISOString().slice(0, 10),
    metrics: "audienceWatchRatio,relativeRetentionPerformance",
    dimensions: "elapsedVideoTimeRatio",
    filters: `video==${id}`,
  });
  const rows = r.data.rows ?? [];
  const pick = [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1].map((p) => rows.find((x) => Math.abs(Number(x[0]) - p) < 0.006));
  console.log(id, pick.map((x) => (x ? `${Math.round(Number(x[0]) * 100)}%:${Number(x[1]).toFixed(2)}(rel ${Number(x[2]).toFixed(2)})` : "-")).join("  "));
}
