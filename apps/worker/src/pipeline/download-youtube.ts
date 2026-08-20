import path from "node:path";
import { runYtDlp } from "../lib/yt-dlp.js";

export interface YoutubeDownloadResult {
  filePath: string;
  title: string;
  durationSeconds: number | null;
}

const YOUTUBE_URL_PATTERN = /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)/i;

export function isSupportedYoutubeUrl(url: string): boolean {
  return YOUTUBE_URL_PATTERN.test(url.trim());
}

/**
 * Scarica un video YouTube in locale via yt-dlp (mux audio+video in mp4, richiede ffmpeg
 * nel PATH) e ne ritorna titolo/durata reali per popolare progetto e video.
 */
export async function downloadYoutubeVideo(url: string, outputDir: string): Promise<YoutubeDownloadResult> {
  const outputPath = path.join(outputDir, "source.mp4");

  const { stdout } = await runYtDlp([
    "-f",
    "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
    "--merge-output-format",
    "mp4",
    "--no-playlist",
    "--print-json",
    "-o",
    outputPath,
    url,
  ]);

  const lastLine = stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .pop();

  if (!lastLine) {
    throw new Error("yt-dlp non ha restituito metadati per il video (output vuoto)");
  }

  let info: { title?: string; duration?: number };
  try {
    info = JSON.parse(lastLine) as { title?: string; duration?: number };
  } catch {
    throw new Error("yt-dlp ha restituito metadati non validi (JSON non parsabile)");
  }

  return {
    filePath: outputPath,
    title: info.title?.trim() || "Video YouTube importato",
    durationSeconds: typeof info.duration === "number" ? info.duration : null,
  };
}
