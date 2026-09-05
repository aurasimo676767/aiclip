import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.resolve("C:/Users/simoa/clipforge/apps/worker/.env"));
loadEnvFile(path.resolve("C:/Users/simoa/clipforge/apps/web/.env.local"));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function getAccessToken(connection) {
  const expiresInMs = new Date(connection.expires_at).getTime() - Date.now();
  if (expiresInMs > 60_000) return connection.access_token;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tokens = await res.json();
  if (!res.ok) throw new Error(`Refresh token fallito: ${JSON.stringify(tokens)}`);

  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  await supabase
    .from("youtube_connections")
    .update({ access_token: tokens.access_token, expires_at: newExpiresAt })
    .eq("id", connection.id);

  return tokens.access_token;
}

async function main() {
  const { data: connections, error: connError } = await supabase.from("youtube_connections").select("*").limit(1);
  if (connError || !connections || connections.length === 0) throw new Error(`Nessuna connessione YouTube trovata: ${connError?.message}`);
  const connection = connections[0];
  console.log(`Canale: ${connection.channel_title}`);

  const accessToken = await getAccessToken(connection);

  const { data: jobs, error: jobsError } = await supabase
    .from("youtube_publish_jobs")
    .select("clip_id, youtube_video_id, completed_at")
    .eq("status", "COMPLETED")
    .is("cancelled_at", null)
    .not("youtube_video_id", "is", null);
  if (jobsError) throw new Error(jobsError.message);

  const clipIds = jobs.map((j) => j.clip_id);
  const { data: clips } = await supabase.from("clips").select("id, format, title").in("id", clipIds);
  const clipMeta = new Map(clips.map((c) => [c.id, c]));

  const videoIds = [...new Set(jobs.map((j) => j.youtube_video_id))];
  const statsByVideoId = new Map();

  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const params = new URLSearchParams({ part: "statistics,snippet", id: chunk.join(",") });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Chiamata YouTube fallita: ${JSON.stringify(data)}`);
    for (const item of data.items ?? []) {
      statsByVideoId.set(item.id, { stats: item.statistics, publishedAt: item.snippet?.publishedAt });
    }
  }

  console.log(`\nTotale job pubblicati con video_id: ${jobs.length}, trovati su YouTube: ${statsByVideoId.size}\n`);

  const rows = [];
  for (const j of jobs) {
    const meta = clipMeta.get(j.clip_id);
    const yt = statsByVideoId.get(j.youtube_video_id);
    if (!yt) {
      rows.push({ format: meta?.format ?? "?", title: meta?.title ?? "?", publishedAt: j.completed_at, views: "RIMOSSO/NON_TROVATO", likes: "", comments: "" });
      continue;
    }
    rows.push({
      format: meta?.format ?? "?",
      title: meta?.title ?? "?",
      publishedAt: yt.publishedAt ?? j.completed_at,
      views: yt.stats?.viewCount ?? "0",
      likes: yt.stats?.likeCount ?? "0",
      comments: yt.stats?.commentCount ?? "0",
    });
  }

  rows.sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
  for (const r of rows) {
    console.log(`[${r.format}] ${r.publishedAt} views=${r.views} likes=${r.likes} comments=${r.comments} | ${r.title}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
