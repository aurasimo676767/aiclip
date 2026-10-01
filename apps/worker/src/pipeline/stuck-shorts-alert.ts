import fs from "node:fs";
import path from "node:path";
import { feedRisk } from "@clipforge/shared";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { sendTelegramText } from "../lib/telegram.js";

/**
 * Avviso su Telegram per gli Shorts che YouTube non ha messo nel feed (simo, 2026-10-01: "tutti vai"
 * all'idea dell'allarme). Di norma uno Short fa ~1.000-1.300 views nel primo giorno; sotto le 200
 * dopo 24 ore è quasi sempre bloccato (analisi del 2026-09-30: titoli con parole a rischio). Una
 * sola volta per Short (gli id avvisati restano in tmp/alerts).
 */
const BLOCKED_VIEWS = 200;
const MIN_AGE_MS = 24 * 3600 * 1000;
const MAX_AGE_MS = 72 * 3600 * 1000;

export async function alertStuckShorts(): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  const memo = path.join(env.WORKER_TMP_DIR, "alerts", "stuck-shorts.json");
  const alerted = new Set<string>(fs.existsSync(memo) ? (JSON.parse(fs.readFileSync(memo, "utf8")) as string[]) : []);

  const since = new Date(Date.now() - MAX_AGE_MS).toISOString();
  const { data: jobs } = await supabase
    .from("youtube_publish_jobs")
    .select("id, clip_id, title, description, youtube_url, view_count, publish_at, completed_at, stats_updated_at, cancelled_at")
    .eq("status", "COMPLETED")
    .is("cancelled_at", null)
    .gte("completed_at", since);
  const found: string[] = [];
  for (const j of jobs ?? []) {
    if (alerted.has(j.id) || j.view_count === null || !j.stats_updated_at) continue;
    const out = new Date(j.publish_at ?? j.completed_at ?? 0).getTime();
    const age = Date.now() - out;
    if (age < MIN_AGE_MS || age > MAX_AGE_MS || j.view_count >= BLOCKED_VIEWS) continue;
    const { data: clip } = await supabase.from("clips").select("format").eq("id", j.clip_id).maybeSingle();
    if (clip?.format !== "short") continue;
    const words = feedRisk(`${j.title}\n${j.description ?? ""}`);
    const hours = Math.round(age / 3600000);
    found.push(
      `⚠️ Short probabilmente BLOCCATO dal feed: "${j.title}" — ${j.view_count} views dopo ${hours} ore (di solito ~1.000).\n` +
        (words.length > 0
          ? `Motivo probabile: parole a rischio nel titolo/descrizione: ${words.join(", ")}.`
          : "Nel testo non ci sono parole a rischio: forse il contenuto (sesso/volgarità forte nell'audio) o un problema di copyright: controlla su YouTube Studio.") +
        (j.youtube_url ? `\n${j.youtube_url}` : ""),
    );
    alerted.add(j.id);
  }
  if (found.length === 0) return;
  for (const text of found) await sendTelegramText(text);
  fs.mkdirSync(path.dirname(memo), { recursive: true });
  fs.writeFileSync(memo, JSON.stringify([...alerted]));
  logger.info("Avviso Shorts bloccati inviato su Telegram", { quanti: found.length });
}
