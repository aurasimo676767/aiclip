import fsp from "node:fs/promises";
import path from "node:path";
import { probeVideo, runFfmpeg, runFfprobe } from "../lib/ffmpeg.js";
import { toFfmpegFilterPath } from "./ffmpeg-filter-utils.js";
import { escapeAssText, formatAssTime } from "./captions.js";

const CREDITS_CARD_SECONDS = 3;
const CREDITS_BACKGROUND_COLOR = "0x141414";
// Target audio comune a tutti e 3 i pezzi (contenuto + 2 card): l'audio del contenuto viene
// comunque ri-codificato per il loudnorm, quindi tanto vale scegliere parametri fissi qui e farci
// combaciare anche le card, invece di inseguire quelli (variabili) della sorgente.
const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_CHANNELS = 2;

export interface RenderLongformClipParams {
  sourceVideoPath: string;
  start: number;
  end: number;
  /** Nome/handle dello streamer originale, mostrato nella card di apertura/chiusura. Null = testo generico. */
  streamerName: string | null;
  workDir: string;
  outputPath: string;
}

interface VideoStreamParams {
  codecName: string;
  profile: string | null;
  level: number | null;
  pixFmt: string;
  width: number;
  height: number;
  frameRate: string; // es. "30/1", passato così com'è a -r
  /** Denominatore del time_base del segmento (es. 90000) — le card DEVONO usare lo stesso, vedi nota su -video_track_timescale. */
  trackTimescale: number | null;
}

/**
 * Renderizza un segmento long-form: SOLO trim + card dei crediti allo streamer originale in
 * apertura/chiusura (nessun crop 9:16, zoom o sottotitoli sul contenuto principale). A differenza
 * della prima versione, il contenuto principale NON viene ri-codificato — su un blocco di
 * 15-40 minuti la differenza è minuti contro secondi:
 *
 * 1. Il segmento [start, end] viene estratto con COPIA DIRETTA del video (nessun decode/encode,
 *    quindi anche zero perdita di qualità rispetto alla sorgente) — solo l'audio viene
 *    ri-codificato, per applicare comunque il loudnorm (economico, l'audio è leggero da
 *    processare rispetto al video).
 * 2. Le card dei crediti (3s ciascuna) vengono generate con GLI STESSI parametri video del
 *    segmento appena estratto (stesso profilo/livello H.264, risoluzione, frame rate, E LO STESSO
 *    time_base del contenitore via -video_track_timescale) — sono gli unici pezzi realmente
 *    "renderizzati" da zero, ma durano 3 secondi, quindi il costo è trascurabile. Il time_base
 *    combaciante non è un dettaglio: senza, il -c copy del passo 3 concatena correttamente i
 *    pacchetti ma con DTS in unità diverse, e ffmpeg li "ripara" incrementandoli di un'unità alla
 *    volta — la durata risultante è totalmente sballata (osservato in pratica: 575s+3s+3s diventati
 *    3386s), pur senza che il comando fallisca con un errore.
 * 3. I tre pezzi (intro, contenuto, outro) vengono concatenati con IL DEMUXER concat (-c copy):
 *    a differenza del filtro concat usato prima, questo non decodifica/ricodifica nulla, si
 *    limita a incollare i pacchetti già codificati — possibile solo perché i tre pezzi hanno
 *    ora parametri video coincidenti.
 *
 * Nota sul taglio: con la ricerca a livello di demuxer (-ss prima di -i, necessaria per essere
 * rapida) il punto di inizio effettivo si allinea al fotogramma-chiave più vicino, non al secondo
 * esatto scelto dall'AI — lo scarto tipico è di 1-4 secondi, impercettibile per un blocco di
 * attività intero.
 *
 * Il testo delle card usa il filtro "subtitles" (libass) invece di "drawtext": su questa macchina
 * drawtext richiede fontconfig configurato e va in crash ("Fontconfig error"), libass è lo stesso
 * meccanismo già testato e funzionante per i sottotitoli degli Shorts.
 */
export async function renderLongformClip(params: RenderLongformClipParams): Promise<{ durationSeconds: number }> {
  const { sourceVideoPath, start, end, streamerName, workDir, outputPath } = params;

  const sourceProbe = await probeVideo(sourceVideoPath);
  if (!sourceProbe.hasVideo || !sourceProbe.width || !sourceProbe.height) {
    throw new Error("Il file sorgente non contiene una traccia video valida");
  }
  if (!sourceProbe.hasAudio) {
    throw new Error("Il file sorgente non contiene una traccia audio (richiesta per il render long-form)");
  }

  // 1) Estrae il segmento: video in copia diretta, audio ri-codificato con loudnorm.
  const segmentPath = path.join(workDir, "segment.mp4");
  await runFfmpeg(
    [
      "-y",
      "-ss",
      String(start),
      "-to",
      String(end),
      "-i",
      sourceVideoPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-ar",
      String(AUDIO_SAMPLE_RATE),
      "-ac",
      String(AUDIO_CHANNELS),
      "-b:a",
      "192k",
      "-af",
      "loudnorm=I=-14:TP=-1.5:LRA=11",
      "-movflags",
      "+faststart",
      segmentPath,
    ],
    { timeoutMs: 10 * 60 * 1000 },
  );

  // 2) Legge i parametri video REALI del segmento appena estratto (non della sorgente originale,
  // che yt-dlp potrebbe aver rimuxato con parametri leggermente diversi) — le card devono
  // combaciare con QUESTI per poter essere concatenate senza ri-codifica.
  const videoParams = await probeVideoStreamParams(segmentPath);

  const creditsText = streamerName ? `Live originale di ${streamerName}` : "Live originale";
  const assPath = path.join(workDir, "credits.ass");
  await fsp.writeFile(assPath, buildCreditsAss(creditsText, videoParams.width, videoParams.height), "utf-8");
  const assFilterPath = toFfmpegFilterPath(assPath);

  const introPath = path.join(workDir, "intro.mp4");
  const outroPath = path.join(workDir, "outro.mp4");
  await buildCreditsCard(assFilterPath, videoParams, introPath);
  await buildCreditsCard(assFilterPath, videoParams, outroPath);

  // 3) Concatena i tre pezzi SENZA ri-codificare (-c copy): richiede parametri combacianti,
  // garantiti dai due passaggi sopra.
  const concatListPath = path.join(workDir, "concat-list.txt");
  const concatList = [introPath, segmentPath, outroPath].map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await fsp.writeFile(concatListPath, concatList, "utf-8");

  await runFfmpeg(
    ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", "-movflags", "+faststart", outputPath],
    { timeoutMs: 5 * 60 * 1000 },
  );

  const outputProbe = await probeVideo(outputPath);
  return { durationSeconds: outputProbe.durationSeconds };
}

async function probeVideoStreamParams(filePath: string): Promise<VideoStreamParams> {
  const { stdout } = await runFfprobe([
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,profile,level,pix_fmt,width,height,r_frame_rate,time_base",
    "-print_format",
    "json",
    filePath,
  ]);
  const data = JSON.parse(stdout) as {
    streams?: Array<{
      codec_name?: string;
      profile?: string;
      level?: number;
      pix_fmt?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      time_base?: string; // es. "1/90000"
    }>;
  };
  const stream = data.streams?.[0];
  if (!stream || !stream.width || !stream.height) {
    throw new Error(`Impossibile leggere i parametri video di "${filePath}"`);
  }
  const timebaseDenominator = stream.time_base ? Number(stream.time_base.split("/")[1]) : NaN;
  return {
    codecName: stream.codec_name ?? "h264",
    profile: stream.profile ?? null,
    level: typeof stream.level === "number" && stream.level > 0 ? stream.level : null,
    pixFmt: stream.pix_fmt ?? "yuv420p",
    width: stream.width,
    height: stream.height,
    frameRate: stream.r_frame_rate ?? "30/1",
    trackTimescale: Number.isFinite(timebaseDenominator) && timebaseDenominator > 0 ? timebaseDenominator : null,
  };
}

/** Mappa il nome profilo riportato da ffprobe (es. "High") al valore accettato da -profile:v di libx264. */
function mapToLibx264Profile(profile: string | null): string | null {
  if (!profile) return null;
  const normalized = profile.toLowerCase().replace(/[^a-z0-9]/g, "");
  const known = ["baseline", "main", "high", "high10", "high422", "high444"];
  if (known.includes(normalized)) return normalized;
  // "constrainedbaseline" e varianti simili: libx264 non ha un profilo dedicato, "baseline" è il
  // superset più vicino accettato dal flag.
  if (normalized.includes("baseline")) return "baseline";
  return null;
}

/**
 * Sceglie l'encoder giusto in base al codec REALE del segmento (Twitch serve i VOD sia in H.264
 * che in AV1 a seconda del caso — osservato in pratica su un file di test, non un'ipotesi) e
 * ritorna gli argomenti ffmpeg per configurarlo. Un codec non gestito qui farebbe fallire la
 * concatenazione finale in modo silenzioso/confuso, meglio un errore chiaro subito.
 */
function buildVideoEncoderArgs(videoParams: VideoStreamParams): string[] {
  switch (videoParams.codecName) {
    case "h264": {
      const profile = mapToLibx264Profile(videoParams.profile);
      return [
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        videoParams.pixFmt,
        ...(profile ? ["-profile:v", profile] : []),
        ...(videoParams.level ? ["-level:v", (videoParams.level / 10).toFixed(1)] : []),
      ];
    }
    case "av1":
      // SVT-AV1: molto più veloce di libaom-av1 a parità di qualità — per una card di 3s la
      // velocità non incide comunque sul totale, ma non c'è motivo di usare l'encoder lento.
      return ["-c:v", "libsvtav1", "-preset", "8", "-crf", "30", "-pix_fmt", videoParams.pixFmt];
    case "hevc":
      return ["-c:v", "libx265", "-preset", "medium", "-crf", "20", "-pix_fmt", videoParams.pixFmt];
    default:
      throw new Error(
        `Codec video "${videoParams.codecName}" non supportato per la card dei crediti (render long-form) — aggiungi un encoder corrispondente.`,
      );
  }
}

async function buildCreditsCard(assFilterPath: string, videoParams: VideoStreamParams, outputPath: string): Promise<void> {
  const args = [
    "-y",
    "-t",
    String(CREDITS_CARD_SECONDS),
    "-f",
    "lavfi",
    "-i",
    `color=c=${CREDITS_BACKGROUND_COLOR}:s=${videoParams.width}x${videoParams.height}:r=${videoParams.frameRate}`,
    "-t",
    String(CREDITS_CARD_SECONDS),
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=${AUDIO_CHANNELS === 2 ? "stereo" : "mono"}`,
    "-vf",
    `subtitles='${assFilterPath}'`,
    "-map",
    "0:v",
    "-map",
    "1:a",
    ...buildVideoEncoderArgs(videoParams),
    // Fondamentale per il -c copy del concat demuxer dopo: se il time_base del contenitore
    // differisse da quello del segmento (il default dell'encoder quasi certamente non combacia),
    // il concat produce un file con DTS corrotti e una durata totalmente sballata SENZA che
    // ffmpeg segnali un errore — bug reale osservato e verificato (vedi commento in cima al file).
    ...(videoParams.trackTimescale ? ["-video_track_timescale", String(videoParams.trackTimescale)] : []),
    "-c:a",
    "aac",
    "-ar",
    String(AUDIO_SAMPLE_RATE),
    "-ac",
    String(AUDIO_CHANNELS),
    "-b:a",
    "192k",
    outputPath,
  ];
  await runFfmpeg(args, { timeoutMs: 2 * 60 * 1000 });
}

/** ASS minimale: una riga centrata, ferma per tutta la durata della card dei crediti. */
function buildCreditsAss(text: string, width: number, height: number): string {
  const fontSize = Math.round(height / 18);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,5,60,60,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const dialogue = `Dialogue: 0,${formatAssTime(0)},${formatAssTime(CREDITS_CARD_SECONDS)},Default,,0,0,0,,${escapeAssText(text)}`;
  return `${header}\n${dialogue}\n`;
}
