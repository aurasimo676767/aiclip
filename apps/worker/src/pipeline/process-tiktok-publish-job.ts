import fsp from "node:fs/promises";
import path from "node:path";
import type { Database, TiktokPublishJobRow } from "@clipforge/db";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";

/**
 * Pubblica una clip su TikTok con la Content Posting API (Direct Post, caricamento del file a pezzi).
 * Le scelte (privacy, commenti, contenuto commerciale) le ha fatte simo nella finestra "Pubblica su
 * TikTok" del sito. Chiesto il 2026-09-28. Finché TikTok non approva l'app (Sandbox), i video escono
 * solo privati: è una regola loro.
 */

const API = "https://open.tiktokapis.com/v2";
const CHUNK_SIZE = 10 * 1024 * 1024;
const MIN_CHUNK = 5 * 1024 * 1024;
const STATUS_POLL_MS = 5000;
const STATUS_TIMEOUT_MS = 15 * 60 * 1000;

interface ApiError {
  code: string;
  message: string;
  log_id?: string;
}

async function tiktokJson<T>(url: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: ApiError };
  if (!res.ok || (json.error && json.error.code !== "ok") || !json.data) {
    throw new Error(`TikTok ${url.split("/v2/")[1]}: ${json.error?.message || json.error?.code || res.status}`);
  }
  return json.data;
}

/** Token valido, rinnovato se scade entro 5 minuti. */
async function accessToken(userId: string): Promise<string> {
  const { data: conn } = await supabase.from("tiktok_connections").select("access_token, refresh_token, expires_at").eq("user_id", userId).maybeSingle();
  if (!conn) throw new Error("TikTok non collegato: collegalo dalle Opzioni");
  if (new Date(conn.expires_at).getTime() - Date.now() > 5 * 60 * 1000) return conn.access_token;
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) throw new Error("TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET mancanti nel .env del worker");
  const res = await fetch(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: conn.refresh_token,
    }),
  });
  const t = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
  if (!t.access_token) throw new Error(`Rinnovo token TikTok fallito: ${t.error_description ?? res.status}. Ricollega TikTok dalle Opzioni`);
  await supabase
    .from("tiktok_connections")
    .update({
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? conn.refresh_token,
      expires_at: new Date(Date.now() + (t.expires_in ?? 86400) * 1000).toISOString(),
    })
    .eq("user_id", userId);
  return t.access_token;
}

async function setStatus(jobId: string, fields: Database["public"]["Tables"]["tiktok_publish_jobs"]["Update"]): Promise<void> {
  const { error } = await supabase.from("tiktok_publish_jobs").update(fields).eq("id", jobId);
  if (error) logger.warn("Aggiornamento tiktok_publish_job fallito", { jobId, error: error.message });
}

export async function processTiktokPublishJob(job: TiktokPublishJobRow): Promise<void> {
  const workDir = path.join(env.WORKER_TMP_DIR, `tiktok-${job.id}`);
  try {
    await setStatus(job.id, { status: "UPLOADING", error_message: null });
    const { data: clip } = await supabase.from("clips").select("output_video_path").eq("id", job.clip_id).single();
    if (!clip?.output_video_path) throw new Error("La clip non ha un video renderizzato");
    const token = await accessToken(job.user_id);

    await fsp.mkdir(workDir, { recursive: true });
    const file = path.join(workDir, "clip.mp4");
    await storageProvider.downloadToFile(clip.output_video_path, file);
    const size = (await fsp.stat(file)).size;

    // Regole TikTok: pezzi da 5 a 64 MB, l'ultimo si prende il resto; sotto i 5 MB un pezzo solo.
    const chunkSize = size < MIN_CHUNK ? size : CHUNK_SIZE;
    const chunkCount = size < MIN_CHUNK ? 1 : Math.floor(size / chunkSize);
    const init = await tiktokJson<{ publish_id: string; upload_url: string }>(`${API}/post/publish/video/init/`, token, {
      post_info: {
        title: job.caption,
        privacy_level: job.privacy_level,
        disable_comment: job.disable_comment,
        disable_duet: job.disable_duet,
        disable_stitch: job.disable_stitch,
        video_cover_timestamp_ms: 1000,
        brand_organic_toggle: job.brand_organic_toggle,
        brand_content_toggle: job.brand_content_toggle,
      },
      source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: chunkCount },
    });
    await setStatus(job.id, { publish_id: init.publish_id });

    const fd = await fsp.open(file, "r");
    try {
      for (let i = 0; i < chunkCount; i++) {
        const start = i * chunkSize;
        const end = i === chunkCount - 1 ? size - 1 : start + chunkSize - 1;
        const buf = Buffer.alloc(end - start + 1);
        await fd.read(buf, 0, buf.length, start);
        const res = await fetch(init.upload_url, {
          method: "PUT",
          headers: { "Content-Type": "video/mp4", "Content-Length": String(buf.length), "Content-Range": `bytes ${start}-${end}/${size}` },
          body: buf,
        });
        if (!res.ok) throw new Error(`Caricamento su TikTok fallito al pezzo ${i + 1}/${chunkCount}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    } finally {
      await fd.close();
    }
    await setStatus(job.id, { status: "PROCESSING" });
    logger.info("TikTok: video caricato, attendo la pubblicazione", { jobId: job.id, publishId: init.publish_id, mb: Math.round(size / 1e6) });

    const deadline = Date.now() + STATUS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, STATUS_POLL_MS));
      const st = await tiktokJson<{ status: string; fail_reason?: string; publicaly_available_post_id?: Array<string | number> }>(
        `${API}/post/publish/status/fetch/`,
        await accessToken(job.user_id),
        { publish_id: init.publish_id },
      );
      if (st.status === "PUBLISH_COMPLETE") {
        const postId = st.publicaly_available_post_id?.[0];
        await setStatus(job.id, { status: "COMPLETED", tiktok_post_id: postId !== undefined ? String(postId) : null, completed_at: new Date().toISOString() });
        logger.info("TikTok: pubblicato", { jobId: job.id, postId });
        return;
      }
      if (st.status === "FAILED") throw new Error(`TikTok ha rifiutato il video: ${st.fail_reason ?? "motivo non indicato"}`);
    }
    throw new Error("TikTok non ha finito di elaborare il video in 15 minuti: controlla il profilo");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Pubblicazione TikTok fallita", { jobId: job.id, error: message });
    await setStatus(job.id, { status: "FAILED", error_message: message, completed_at: new Date().toISOString() });
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

