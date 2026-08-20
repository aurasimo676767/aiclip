import { spawn } from "node:child_process";

export class YtDlpError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "YtDlpError";
  }
}

export interface YtDlpResult {
  stdout: string;
  stderr: string;
}

/** Esegue yt-dlp e ne raccoglie stdout/stderr, con timeout (il download di un video lungo può richiedere minuti). */
export function runYtDlp(args: string[], options: { timeoutMs?: number } = {}): Promise<YtDlpResult> {
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new YtDlpError(`Impossibile avviare yt-dlp: ${err.message}. È installato ed è nel PATH?`, stderr));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new YtDlpError(`yt-dlp ha superato il timeout di ${timeoutMs}ms ed è stato terminato`, stderr));
        return;
      }
      if (code !== 0) {
        reject(new YtDlpError(`yt-dlp terminato con codice ${code}: ${stderr.slice(-500)}`, stderr));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
