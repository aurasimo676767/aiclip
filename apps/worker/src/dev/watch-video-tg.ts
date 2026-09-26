import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { sendTelegramText } from "../lib/telegram.js";

/**
 * Segue un video in lavorazione e manda a simo su Telegram ogni passaggio: cambio di fase,
 * avanzamento del download, clip trovate, render finiti o falliti. Si ferma quando il video è
 * pronto (o fallito) e non ci sono più render in corso da 10 minuti. Legge e basta: non tocca
 * il worker. Uso: tsx src/dev/watch-video-tg.ts <video_id>
 */
const videoId = process.argv[2];
if (!videoId) throw new Error("Uso: tsx src/dev/watch-video-tg.ts <video_id>");

const PHASES: Record<string, string> = {
  UPLOADING: "caricamento",
  UPLOADED: "in coda",
  DOWNLOADING: "download del VOD",
  EXTRACTING_AUDIO: "estrazione dell'audio",
  TRANSCRIBING: "trascrizione (Whisper)",
  ANALYZING: "analisi dei momenti",
  CLIP_SELECTION: "scelta dei tagli",
  READY: "PRONTO",
  FAILED: "FALLITO",
};

const POLL_MS = 30_000;
const DOWNLOAD_REPORT_MS = 10 * 60_000;
const IDLE_STOP_MS = 10 * 60_000;
const MAX_RUN_MS = 24 * 3600_000;

async function say(text: string): Promise<void> {
  const stamp = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  console.log(`[${stamp}] ${text.replace(/\n/g, " | ")}`);
  try {
    await sendTelegramText(`🎬 ${text}`);
  } catch (err) {
    console.log(`telegram fallito: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** GB già scaricati: il file parziale più i frammenti ancora da unire. */
async function downloadedGb(): Promise<number> {
  const dir = path.resolve(process.env.WORKER_TMP_DIR ?? "./tmp", `video-${videoId}`);
  let bytes = 0;
  for (const f of await fsp.readdir(dir).catch(() => [] as string[])) {
    if (f.startsWith("source")) bytes += (await fsp.stat(path.join(dir, f)).catch(() => ({ size: 0 }))).size;
  }
  return bytes / 1e9;
}

const started = Date.now();
let lastStatus = "";
let lastDownloadReport = 0;
let clipsAnnounced = false;
const clipState = new Map<string, string>();
let idleSince: number | null = null;

while (Date.now() - started < MAX_RUN_MS) {
  const { data: video } = await supabase
    .from("videos")
    .select("status,error_message,original_filename,duration_seconds")
    .eq("id", videoId)
    .single();
  if (!video) {
    await say(`Non trovo più il video ${videoId}, smetto di seguirlo.`);
    break;
  }

  if (video.status !== lastStatus) {
    const name = video.original_filename ? ` "${video.original_filename}"` : "";
    if (video.status === "FAILED") await say(`VOD${name} FALLITO: ${video.error_message ?? "nessun dettaglio"}`);
    else if (!lastStatus) await say(`Seguo il VOD${name}. Fase attuale: ${PHASES[video.status] ?? video.status}.`);
    else await say(`VOD, fatto: ${PHASES[lastStatus] ?? lastStatus}. Ora: ${PHASES[video.status] ?? video.status}.`);
    lastStatus = video.status;
    lastDownloadReport = Date.now();
  } else if (video.status === "DOWNLOADING" && Date.now() - lastDownloadReport > DOWNLOAD_REPORT_MS) {
    await say(`Download in corso: ${(await downloadedGb()).toFixed(1)} GB scaricati.`);
    lastDownloadReport = Date.now();
  }

  const { data: clips } = await supabase
    .from("clips")
    .select("id,title,status,duration,error_message")
    .eq("video_id", videoId)
    .order("start_time");
  if (clips && clips.length > 0 && !clipsAnnounced) {
    const list = clips
      .slice(0, 15)
      .map((c, i) => `${i + 1}. ${c.title} (${c.duration < 90 ? `${Math.round(c.duration)} s` : `${Math.round(c.duration / 60)} min`})`)
      .join("\n");
    await say(`Trovati ${clips.length} video:\n${list}${clips.length > 15 ? "\n…" : ""}`);
    clipsAnnounced = true;
  }
  let busy = false;
  for (const c of clips ?? []) {
    const before = clipState.get(c.id);
    if (before && before !== c.status) {
      if (c.status === "RENDERING") await say(`Render iniziato: "${c.title}"`);
      else if (c.status === "COMPLETED") {
        const done = (clips ?? []).filter((x) => x.status === "COMPLETED").length;
        await say(`Render finito: "${c.title}" (${done}/${clips!.length} pronti)`);
      } else if (c.status === "FAILED") await say(`Render FALLITO: "${c.title}": ${c.error_message ?? "nessun dettaglio"}`);
    }
    clipState.set(c.id, c.status);
    if (c.status === "QUEUED" || c.status === "RENDERING") busy = true;
  }

  const finished = video.status === "READY" || video.status === "FAILED";
  if (finished && !busy) {
    idleSince ??= Date.now();
    if (Date.now() - idleSince > IDLE_STOP_MS) {
      await say("Fine: nessun render in corso da 10 minuti, smetto di seguire il VOD.");
      break;
    }
  } else idleSince = null;

  await new Promise((r) => setTimeout(r, POLL_MS));
}
