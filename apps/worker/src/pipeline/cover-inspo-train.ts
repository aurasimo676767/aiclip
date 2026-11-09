import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";
import { runYtDlp } from "../lib/yt-dlp.js";
import { isWorkerPaused } from "../lib/pause-control.js";
import { analyzeInspoCover } from "../providers/ai/cover-inspo-analysis.js";
import {
  inspoRoot,
  readInspoConfig,
  readInspoIndex,
  writeInspoConfig,
  writeInspoIndex,
  type InspoChannel,
  type InspoConfig,
  type InspoIndex,
  type InspoItem,
} from "../lib/cover-inspo.js";

/** Ultimi video guardati per canale: abbastanza per capire cosa funziona, pochi da studiare (~0,03 cent l'uno). */
const VIDEOS_PER_CHANNEL = 60;
/** Sotto i 2 minuti è uno Short (la copertina è un fotogramma, non serve). */
const MIN_DURATION_SECONDS = 120;
/** I video più recenti di così non hanno ancora i numeri veri: niente punteggio. */
const FRESH_DAYS = 4;
/** Una volta allenato, si riguardano i canali da soli ogni settimana: si studiano solo le copertine nuove. */
const AUTO_RETRAIN_MS = 7 * 24 * 3600 * 1000;
const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const ANALYSIS_CONCURRENCY = 4;

interface ListedVideo {
  id: string;
  duration: number | null;
  views: number | null;
  title: string;
  channel: string;
}

/** Video lunghi di un canale con visualizzazioni e titolo originale (in italiano: YouTube li traduce). */
async function listChannel(channel: InspoChannel): Promise<ListedVideo[]> {
  const base = channel.url.trim().replace(/\/+$/, "").replace(/\/(videos|shorts|streams|featured)$/, "");
  const url = /^https?:\/\//.test(base) ? `${base}/videos` : `https://www.youtube.com/${base.startsWith("@") ? base : `@${base}`}/videos`;
  const { stdout } = await runYtDlp(
    ["--encoding", "utf-8", "--flat-playlist", "--playlist-end", String(VIDEOS_PER_CHANNEL), "--extractor-args", "youtube:lang=it", "--print", "%(id)s\t%(duration)s\t%(view_count)s\t%(playlist_channel)s\t%(title)s", url],
    { inactivityTimeoutMs: 120_000 },
  );
  return stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, "").split("\t"))
    .filter((cols) => cols.length >= 5 && /^[\w-]{11}$/.test(cols[0]!))
    .map(([id, duration, views, name, ...title]) => ({
      id: id!,
      duration: Number(duration) || null,
      views: Number(views) || null,
      title: title.join("\t").trim(),
      channel: channel.name?.trim() || (name && name !== "NA" ? name : base.split("/").pop()!),
    }));
}

/**
 * Data approssimata ("2 settimane fa") dei video del canale. Lista a parte: con la lingua italiana
 * yt-dlp non sa leggere "2 settimane fa" e la data resta vuota (provato il 2026-11-09).
 */
async function listDates(channel: InspoChannel): Promise<Map<string, string>> {
  const base = channel.url.trim().replace(/\/+$/, "").replace(/\/(videos|shorts|streams|featured)$/, "");
  const url = /^https?:\/\//.test(base) ? `${base}/videos` : `https://www.youtube.com/${base.startsWith("@") ? base : `@${base}`}/videos`;
  const { stdout } = await runYtDlp(
    ["--flat-playlist", "--playlist-end", String(VIDEOS_PER_CHANNEL), "--extractor-args", "youtubetab:approximate_date", "--print", "%(id)s\t%(upload_date)s", url],
    { inactivityTimeoutMs: 120_000 },
  ).catch(() => ({ stdout: "" }));
  const dates = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [id, date] = line.trim().split("\t");
    if (id && date && /^\d{8}$/.test(date)) dates.set(id, date);
  }
  return dates;
}

function ageDays(uploadDate: string | null): number | null {
  if (!uploadDate) return null;
  const t = Date.UTC(Number(uploadDate.slice(0, 4)), Number(uploadDate.slice(4, 6)) - 1, Number(uploadDate.slice(6, 8)));
  return (Date.now() - t) / 86_400_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Copertina in HD su storage; null se il video non ce l'ha in 1280x720 (le 480p ingrandite non servono). */
async function storeThumbnail(userId: string, videoId: string, workDir: string): Promise<string | null> {
  const res = await fetch(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`);
  if (!res.ok) return null;
  const local = path.join(workDir, `${videoId}.jpg`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (((await sharp(buffer).metadata()).width ?? 0) < 1280) return null;
  await sharp(buffer).resize(1280, 720, { fit: "cover" }).jpeg({ quality: 88 }).toFile(local);
  const key = `${inspoRoot(userId)}/${videoId}.jpg`;
  await storageProvider.uploadFile(local, key, "image/jpeg");
  return key;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

/** Cambia solo i campi indicati, rileggendo il resto: intanto dal sito simo può aver cambiato i canali. */
async function updateInspoConfig(userId: string, workDir: string, patch: Partial<InspoConfig>): Promise<void> {
  const latest = await readInspoConfig(userId, workDir);
  if (latest) await writeInspoConfig(userId, { ...latest, ...patch }, workDir);
}

/**
 * Allena la libreria di un utente: guarda i canali, aggiorna visualizzazioni e punteggi di tutte le
 * copertine, scarica e studia solo quelle nuove. Le copertine dei canali tolti dal sito spariscono;
 * quelle approvate da simo restano sempre.
 */
export async function trainCoverInspo(userId: string, config: InspoConfig, workDir: string): Promise<void> {
  const started = new Date().toISOString();
  const progress = (step: string, done: number, total: number) => updateInspoConfig(userId, workDir, { training: { startedAt: started, done, total, step } }).catch(() => undefined);
  await progress("Guardo i canali", 0, config.channels.length);

  const index = await readInspoIndex(userId, workDir);
  const known = new Map(index.items.map((item) => [item.videoId, item]));
  const fresh: InspoItem[] = [];
  const failedChannels: string[] = [];

  for (const [n, channel] of config.channels.entries()) {
    try {
      const [videos, dates] = await Promise.all([listChannel(channel), listDates(channel)]);
      const long = videos.filter((v) => (v.duration ?? MIN_DURATION_SECONDS) >= MIN_DURATION_SECONDS);
      const settled = long.filter((v) => v.views !== null && (ageDays(dates.get(v.id) ?? known.get(v.id)?.uploadDate ?? null) ?? FRESH_DAYS) >= FRESH_DAYS);
      const mid = median(settled.map((v) => v.views!));
      for (const v of long) {
        const uploadDate = dates.get(v.id) ?? known.get(v.id)?.uploadDate ?? null;
        const isSettled = mid && v.views !== null && (ageDays(uploadDate) ?? FRESH_DAYS) >= FRESH_DAYS;
        fresh.push({
          ...(known.get(v.id) ?? { path: "", addedAt: new Date().toISOString(), source: "canale" as const }),
          videoId: v.id,
          channel: v.channel,
          channelUrl: channel.url,
          title: v.title,
          views: v.views,
          uploadDate,
          outlier: isSettled ? Math.round((v.views! / mid) * 100) / 100 : null,
        });
      }
    } catch (err) {
      failedChannels.push(channel.name ?? channel.url);
      logger.warn("Allenamento copertine: canale non letto", { canale: channel.url, error: err instanceof Error ? err.message : String(err) });
      // Le copertine già studiate di quel canale restano finché non si riesce a rileggerlo.
      for (const item of index.items) if (item.source === "canale" && item.channelUrl === channel.url && !fresh.some((f) => f.videoId === item.videoId)) fresh.push(item);
    }
    await progress("Guardo i canali", n + 1, config.channels.length);
  }

  // Da scaricare e studiare: le nuove e quelle a cui manca ancora lo studio (es. errore la volta prima).
  const todo = fresh.filter((item) => item.source === "canale" && (!item.path || !item.analysis));
  let done = 0;
  let studied = 0;
  await progress("Studio le copertine nuove", 0, todo.length);
  await mapLimit(todo, ANALYSIS_CONCURRENCY, async (item) => {
    try {
      if (!item.path) item.path = (await storeThumbnail(userId, item.videoId, workDir)) ?? "";
      if (item.path && !item.analysis) {
        const local = path.join(workDir, `${item.videoId}.jpg`);
        await fsp.access(local).catch(() => storageProvider.downloadToFile(item.path, local));
        item.analysis = await analyzeInspoCover(local, item.title, { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL_CHEAP });
        studied++;
        await fsp.rm(local, { force: true });
      }
    } catch (err) {
      logger.warn("Allenamento copertine: copertina non studiata", { videoId: item.videoId, error: err instanceof Error ? err.message : String(err) });
    }
    done++;
    if (done % 8 === 0) await progress("Studio le copertine nuove", done, todo.length);
  });

  // Senza copertina HD non si usa: si toglie (si riprova al prossimo giro, se intanto la mettono).
  // Le approvate si rileggono adesso: simo può averne approvata una mentre l'allenamento girava.
  const latest = await readInspoIndex(userId, workDir);
  const items = [...fresh.filter((item) => item.path), ...latest.items.filter((item) => item.source === "approvata")];
  const next: InspoIndex = { items };
  await writeInspoIndex(userId, next, workDir);
  const ready = items.filter((i) => i.analysis).length;
  // L'ora di PARTENZA: se simo ripreme "Allena" mentre questo giro va, il giro dopo parte lo stesso.
  await updateInspoConfig(userId, workDir, {
    training: null,
    lastTrainedAt: started,
    lastError: failedChannels.length > 0 ? `Canali non letti: ${failedChannels.join(", ")}` : null,
    lastSummary: `${ready} copertine studiate da ${config.channels.length} canali (${studied} nuove questa volta)`,
  });
  logger.info("Allenamento copertine finito", { userId, copertine: ready, nuove: studied, canaliNonLetti: failedChannels });
}

/**
 * Copertina approvata da simo col pulsante "Carica": entra nella libreria come una di quelle che
 * funzionano (vedi APPROVED_OUTLIER in lib/cover-inspo.ts), così le copertine dopo imparano anche dai
 * suoi gusti e non solo dai canali. Solo le 16:9: gli Short hanno un'impaginazione diversa.
 */
export async function addApprovedCover(userId: string, coverLocalPath: string, clip: { id: string; title: string }, workDir: string): Promise<void> {
  const { width = 0, height = 0 } = await sharp(coverLocalPath).metadata();
  if (width <= height) return;
  const id = `approvata-${clip.id}`;
  const local = path.join(workDir, `${id}.jpg`);
  await sharp(coverLocalPath).resize(1280, 720, { fit: "cover" }).jpeg({ quality: 88 }).toFile(local);
  const key = `${inspoRoot(userId)}/${id}.jpg`;
  await storageProvider.uploadFile(local, key, "image/jpeg");
  const analysis = await analyzeInspoCover(local, clip.title, { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL_CHEAP });
  await fsp.rm(local, { force: true });
  const index = await readInspoIndex(userId, workDir);
  // Una per video: se simo ne approva un'altra per lo stesso video, vale l'ultima.
  index.items = index.items.filter((item) => item.videoId !== id);
  index.items.push({ videoId: id, channel: "Approvate da te", title: clip.title, views: null, uploadDate: null, outlier: null, source: "approvata", path: key, analysis, addedAt: new Date().toISOString() });
  await writeInspoIndex(userId, index, workDir);
  logger.info("Copertina approvata aggiunta all'allenamento", { clipId: clip.id, scritta: analysis.text });
}

/**
 * Controlla ogni 2 minuti se dal sito è stato premuto "Allena adesso", e riallena da solo una volta a
 * settimana chi ha già allenato almeno una volta (solo le copertine nuove costano: centesimi).
 */
export async function coverInspoLoop(isShuttingDown: () => boolean): Promise<void> {
  const workDir = path.join(env.WORKER_TMP_DIR, "cover-inspo");
  while (!isShuttingDown()) {
    try {
      if (!(await isWorkerPaused())) {
        await fsp.mkdir(workDir, { recursive: true });
        const { data: rows } = await supabase.from("projects").select("user_id").limit(1000);
        for (const userId of new Set((rows ?? []).map((r) => r.user_id as string))) {
          const config = await readInspoConfig(userId, workDir);
          if (!config || config.channels.length === 0) continue;
          const last = config.lastTrainedAt ? Date.parse(config.lastTrainedAt) : 0;
          const requested = config.trainRequestedAt ? Date.parse(config.trainRequestedAt) > last : false;
          const weekly = last > 0 && Date.now() - last > AUTO_RETRAIN_MS;
          if (!requested && !weekly) continue;
          logger.info("Allenamento copertine", { userId, motivo: requested ? "richiesto dal sito" : "giro settimanale", canali: config.channels.length });
          try {
            await trainCoverInspo(userId, config, workDir);
          } catch (err) {
            await updateInspoConfig(userId, workDir, { training: null, lastTrainedAt: new Date().toISOString(), lastError: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
            throw err;
          }
        }
      }
    } catch (err) {
      logger.error("Errore nel loop dell'allenamento copertine", { error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(CHECK_INTERVAL_MS);
  }
}
