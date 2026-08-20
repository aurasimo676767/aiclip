import { spawn } from "node:child_process";
import { logger } from "./logger.js";

export class FFmpegError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "FFmpegError";
  }
}

interface RunOptions {
  timeoutMs?: number;
}

/** Esegue un binario (ffmpeg/ffprobe) e ne raccoglie stdout/stderr, con timeout opzionale. */
function run(bin: "ffmpeg" | "ffprobe", args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000; // 15 minuti default, il render di una clip breve non dovrebbe mai avvicinarsi a questo limite

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
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
      reject(new FFmpegError(`Impossibile avviare ${bin}: ${err.message}. È installato ed è nel PATH?`, null, stderr));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new FFmpegError(`${bin} ha superato il timeout di ${timeoutMs}ms ed è stato terminato`, code, stderr));
        return;
      }
      if (code !== 0) {
        reject(new FFmpegError(`${bin} terminato con codice ${code}`, code, stderr));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function runFfmpeg(args: string[], options?: RunOptions): Promise<{ stdout: string; stderr: string }> {
  logger.info("ffmpeg", { args: args.join(" ") });
  return run("ffmpeg", args, options);
}

export function runFfprobe(args: string[], options?: RunOptions): Promise<{ stdout: string; stderr: string }> {
  return run("ffprobe", args, options);
}

export interface ProbeResult {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { stdout } = await runFfprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
  };

  const videoStream = data.streams?.find((s) => s.codec_type === "video");
  const audioStream = data.streams?.find((s) => s.codec_type === "audio");
  const durationStr = data.format?.duration ?? videoStream?.duration ?? "0";

  return {
    durationSeconds: Number.parseFloat(durationStr) || 0,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
  };
}
