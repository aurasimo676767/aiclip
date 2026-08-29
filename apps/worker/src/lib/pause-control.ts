import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./logger.js";
import { supabase } from "./supabase.js";

const execFileAsync = promisify(execFile);

/** Legge lo stato pausa/ripresa dal sito (tabella worker_control, riga singola). */
export async function isWorkerPaused(): Promise<boolean> {
  const { data, error } = await supabase.from("worker_control").select("paused").eq("id", true).maybeSingle();
  if (error || !data) return false; // se non riusciamo a leggerlo, meglio non bloccare il worker
  return data.paused === true;
}

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/suspend-resume-heavy.ps1");

async function runScript(action: "suspend" | "resume"): Promise<void> {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    SCRIPT_PATH,
    "-Action",
    action,
  ]);
  logger.info(`Processi pesanti ${action === "suspend" ? "sospesi" : "ripresi"}`, { affected: stdout.trim() || "nessuno" });
}

/**
 * Sospende DAVVERO (a livello di thread di sistema, verificato in pratica: CPU ferma durante la
 * pausa) i processi pesanti in corso — ffmpeg, yt-dlp, server whisper locale — invece di limitarsi
 * ad "aspettare" tra una fase e l'altra della pipeline (che non aiuterebbe: il momento critico è
 * proprio dentro una fase lunga).
 */
export async function suspendHeavyProcesses(): Promise<void> {
  await runScript("suspend");
}

export async function resumeHeavyProcesses(): Promise<void> {
  await runScript("resume");
}
