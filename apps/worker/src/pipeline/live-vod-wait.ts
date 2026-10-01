import { runYtDlp } from "../lib/yt-dlp.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { sendTelegramText } from "../lib/telegram.js";

/**
 * VOD di Twitch ancora IN DIRETTA (2026-10-01: VOD di Blur messo in coda con la live ancora in
 * corso): yt-dlp lo scarica alla velocità della live (~0,8 MB/s) e il worker resta bloccato per
 * ore. Prima di scaricare si controlla: se è in diretta il video va "in attesa della fine della
 * live" e un giro periodico lo rimette in coda appena la live finisce.
 */
export const LIVE_WAIT_MESSAGE = "In attesa della fine della live (rimesso in coda in automatico)";

/** true se il VOD Twitch è ancora in diretta. In dubbio (errore di rete) false: si scarica come prima. */
export async function isTwitchVodLive(url: string): Promise<boolean> {
  if (!/twitch\.tv\/videos\//i.test(url)) return false;
  try {
    const { stdout } = await runYtDlp(["--print", "%(live_status)s", "--no-warnings", url]);
    return stdout.trim().split("\n").pop()?.trim() === "is_live";
  } catch (err) {
    logger.warn("Controllo live del VOD fallito, si scarica comunque", { url, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Mette il video in attesa della fine della live (e il progetto, per la dashboard). */
export async function markWaitingForLiveEnd(videoId: string, projectId: string): Promise<void> {
  await supabase.from("videos").update({ status: "FAILED", error_message: LIVE_WAIT_MESSAGE, claimed_by: null, claimed_at: null }).eq("id", videoId);
  await supabase.from("projects").update({ status: "FAILED", error_message: LIVE_WAIT_MESSAGE }).eq("id", projectId);
  logger.info("VOD ancora in diretta: in attesa della fine della live", { videoId });
}

/** Giro periodico: i VOD in attesa la cui live è finita tornano in coda (come "Riprova" dal sito). */
export async function requeueFinishedLives(): Promise<void> {
  const { data } = await supabase.from("videos").select("id, project_id, source_url, original_filename").eq("status", "FAILED").eq("error_message", LIVE_WAIT_MESSAGE);
  for (const v of data ?? []) {
    if (!v.source_url || (await isTwitchVodLive(v.source_url))) continue;
    await supabase
      .from("videos")
      .update({ status: "UPLOADED", error_message: null, claimed_by: null, claimed_at: null, attempts: 0, cancel_requested: false })
      .eq("id", v.id);
    await supabase.from("projects").update({ status: "UPLOADED", error_message: null }).eq("id", v.project_id);
    logger.info("Live finita: VOD rimesso in coda", { videoId: v.id });
    await sendTelegramText(`▶️ La live è finita: ho rimesso in coda il VOD "${v.original_filename ?? v.source_url}". Ora si scarica a tutta velocità.`).catch(() => undefined);
  }
}
