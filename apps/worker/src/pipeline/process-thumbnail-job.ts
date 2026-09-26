import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ThumbnailJobRow } from "@clipforge/db";
import { LONGFORM_STREAMER_ALIASES } from "@clipforge/shared";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";
import { runFfmpeg, probeVideo } from "../lib/ffmpeg.js";
import { selectThumbnailAssets } from "../providers/ai/thumbnail-selection.js";
import { composeCover, COVER_THEMES } from "../render/compose-cover.js";
import { readFaceLibrary } from "../lib/face-library.js";
import { participantsFromTitle, pickFaces, downloadFaces, findSteamHero, referenceFaces } from "./cover-builder.js";
import { generateAiCover } from "../providers/ai/cover-image-ai.js";
import {
  setYoutubeThumbnail,
  findYoutubeThumbnailUrlBySearch,
  fetchBestYoutubeThumbnailUrl,
  type YoutubeCredentials,
} from "../providers/youtube/youtube-publisher.js";
import { updateThumbnailJobStatus } from "../queue/thumbnail-queue.js";

const CANDIDATE_FRAME_COUNT = 8;
// Le card dei crediti (3s) all'inizio/fine del render long-form non sono contenuto vero — le
// escludiamo dal campionamento dei fotogrammi candidati.
const CREDITS_CARD_MARGIN_SECONDS = 4;

/** Estrae l'id video da un URL YouTube in uno dei formati comuni (watch?v=, youtu.be/, shorts/). */
function extractYoutubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  const patterns = [/[?&]v=([a-zA-Z0-9_-]{11})/, /youtu\.be\/([a-zA-Z0-9_-]{11})/, /\/shorts\/([a-zA-Z0-9_-]{11})/];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1]!;
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

export async function processThumbnailJob(job: ThumbnailJobRow): Promise<void> {
  const jobDir = path.join(env.WORKER_TMP_DIR, `thumbnail-${job.id}`);
  await fsp.mkdir(jobDir, { recursive: true });

  try {
    const { data: clip, error: clipError } = await supabase
      .from("clips")
      .select("id, project_id, video_id, title, hook, caption, format, output_video_path, thumbnail_path")
      .eq("id", job.clip_id)
      .single();
    if (clipError || !clip) {
      throw new Error(`Clip ${job.clip_id} non trovata: ${clipError?.message ?? "nessun dato"}`);
    }
    if (clip.format !== "longform") {
      throw new Error("La generazione copertine è disponibile solo per i video long-form");
    }
    if (!clip.output_video_path) {
      throw new Error("La clip non ha ancora un video renderizzato da cui generare la copertina");
    }

    const { data: publishJob, error: publishJobError } = await supabase
      .from("youtube_publish_jobs")
      .select("youtube_video_id")
      .eq("clip_id", clip.id)
      .eq("youtube_url", job.youtube_url)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (publishJobError || !publishJob?.youtube_video_id) {
      throw new Error("Impossibile risalire all'id video YouTube per impostare la copertina");
    }

    // Credenziali YouTube: servono sia per cercare la copertina reale del video reagito sia,
    // alla fine, per impostare il risultato sul video pubblicato — le recuperiamo una volta sola.
    const { data: project } = await supabase.from("projects").select("user_id").eq("id", clip.project_id).single();
    const { data: connectionRow } = project
      ? await supabase.from("youtube_connections").select("*").eq("user_id", project.user_id).maybeSingle()
      : { data: null };
    let credentials: YoutubeCredentials | null = connectionRow
      ? {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          accessToken: connectionRow.access_token,
          refreshToken: connectionRow.refresh_token,
          expiryDate: new Date(connectionRow.expires_at).getTime(),
        }
      : null;

    // 1) Scarica il render già pronto (non il sorgente da 20+GB, quello serve solo per il render vero).
    const localVideoPath = path.join(jobDir, "clip.mp4");
    await storageProvider.downloadToFile(clip.output_video_path, localVideoPath);

    const probe = await probeVideo(localVideoPath);
    const innerStart = CREDITS_CARD_MARGIN_SECONDS;
    const innerEnd = Math.max(innerStart + 1, probe.durationSeconds - CREDITS_CARD_MARGIN_SECONDS);
    const timestamps = sampleTimestamps(innerStart, innerEnd, CANDIDATE_FRAME_COUNT);

    // 2) Fotogrammi candidati a bassa risoluzione, solo per farli "vedere" a Claude (pochi token).
    const lowResPaths = await Promise.all(
      timestamps.map((t, i) => grabFrame(localVideoPath, t, path.join(jobDir, `cand-${i}.jpg`), 768)),
    );
    const lowResBase64 = await Promise.all(lowResPaths.map(async (p) => (await fsp.readFile(p)).toString("base64")));

    const { data: video } = await supabase.from("videos").select("streamer_name").eq("id", clip.video_id).maybeSingle();
    const streamerAlias = video?.streamer_name ? (LONGFORM_STREAMER_ALIASES[video.streamer_name.toLowerCase()] ?? null) : null;

    const selection = await selectThumbnailAssets({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL_CHEAP,
      clipTitle: clip.title,
      clipHook: clip.hook,
      clipCaption: clip.caption ?? "",
      frameJpegsBase64: lowResBase64,
    });

    // 3) Sfondo, in ordine di affidabilità:
    //    a) link del video reagito incollato a mano dall'utente (il più affidabile: nessun
    //       indovinello, presa diretta della copertina ufficiale alla massima risoluzione);
    //    b) titolo/canale letto dall'IA sui fotogrammi + ricerca YouTube (best-effort);
    //    c) fotogramma scelto dall'IA dal nostro stesso video, con eventuale ritaglio anti-interfaccia.
    //    Per un GIOCO si prova prima la grafica ufficiale da Steam (il gioco vero, pulito, senza
    //    webcam e chat); se il gioco non è su Steam si ripiega sul fotogramma (c).
    let backgroundFullPath: string | null = null;
    const isReaction = selection.kind === "reaction" || Boolean(job.reacted_video_url);

    if (!isReaction && selection.gameName) {
      backgroundFullPath = await findSteamHero(selection.gameName, path.join(jobDir, "background-steam.jpg"));
    }

    const manualVideoId = job.reacted_video_url ? extractYoutubeVideoId(job.reacted_video_url) : null;
    if (manualVideoId) {
      try {
        const thumbUrl = await fetchBestYoutubeThumbnailUrl(manualVideoId);
        backgroundFullPath = await downloadImageIfOk(thumbUrl, path.join(jobDir, "background-real-thumb.jpg"));
        if (backgroundFullPath) logger.info("Copertina reale presa dal link incollato dall'utente", { jobId: job.id, manualVideoId });
      } catch (err) {
        logger.warn("Download copertina dal link incollato fallito, provo il ripiego automatico", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!backgroundFullPath && isReaction && selection.reactedVideoQuery && credentials) {
      try {
        const thumbUrl = await findYoutubeThumbnailUrlBySearch(credentials, selection.reactedVideoQuery);
        backgroundFullPath = await downloadImageIfOk(thumbUrl, path.join(jobDir, "background-real-thumb.jpg"));
        if (backgroundFullPath) logger.info("Copertina reale trovata via ricerca YouTube automatica", { jobId: job.id, query: selection.reactedVideoQuery });
      } catch (err) {
        logger.warn("Ricerca copertina reale fallita, ripiego sul fotogramma estratto", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!backgroundFullPath) {
      const backgroundRawPath = path.join(jobDir, "background-raw.jpg");
      await grabFrame(localVideoPath, timestamps[selection.backgroundFrameIndex] ?? timestamps[0]!, backgroundRawPath);

      backgroundFullPath = backgroundRawPath;
      if (selection.contentCropBox) {
        const meta = await sharp(backgroundRawPath).metadata();
        const w = meta.width ?? 0;
        const h = meta.height ?? 0;
        const box = selection.contentCropBox;
        const left = Math.max(0, Math.round(box.x * w));
        const top = Math.max(0, Math.round(box.y * h));
        const right = Math.min(w, Math.round((box.x + box.width) * w));
        const bottom = Math.min(h, Math.round((box.y + box.height) * h));
        if (w > 0 && h > 0 && right - left > 100 && bottom - top > 100) {
          const croppedPath = path.join(jobDir, "background-cropped.jpg");
          await sharp(backgroundRawPath).extract({ left, top, width: right - left, height: bottom - top }).toFile(croppedPath);
          backgroundFullPath = croppedPath;
        }
      }
    }

    // 4) Facce: SOLO persone vere a cui simo ha dato un nome nella pagina Facce (mai generate, mai
    //    indovinate), una sola volta ciascuna, col protagonista del VOD per primo. Se non c'è
    //    nessuna faccia con un nome per le persone del video, la copertina esce senza facce.
    const library = project ? await readFaceLibrary(project.user_id, jobDir) : { faces: [] };
    // Persone scelte a mano dal sito (colonna cover_people, migrazione 0025): vincono sul titolo. Solo
    // chi ha davvero facce col nome in libreria, nell'ordine scelto (il primo è il protagonista).
    const chosenPeople = ((job as { cover_people?: string[] | null }).cover_people ?? [])
      .map((p) => p.toUpperCase())
      .filter((p) => library.faces.some((f) => f.status === "labeled" && f.label === p));
    const people = chosenPeople.length > 0 ? chosenPeople : participantsFromTitle(clip.title, library, streamerAlias);
    const chosenFaces = pickFaces(library, people, selection.desiredExpression, isReaction ? 2 : 4, isReaction ? "reaction" : "game");
    const facePaths = await downloadFaces(chosenFaces, jobDir).catch((err) => {
      logger.warn("Download facce fallito, copertina senza facce", { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
      return [] as string[];
    });

    // 5) Scritta: "<PROTAGONISTA> REACTION" per le reaction (la copertina originale ha già il suo
    //    testo), le 1-3 parole scelte dall'AI per i giochi.
    const title = isReaction
      ? `${people[0] ?? streamerAlias ?? "BLUR"} REACTION`
      : (selection.coverWords ?? extractBannerText(clip.title));
    logger.info("Copertina", { jobId: job.id, tipo: isReaction ? "reaction" : "gioco", gioco: selection.gameName, persone: people, facce: chosenFaces.map((f) => `${f.label}:${f.expression}`), scritta: title });

    const draftPath = path.join(jobDir, "thumbnail-draft.jpg");
    await composeCover({
      backgroundPath: backgroundFullPath,
      kind: isReaction ? "reaction" : "game",
      faces: facePaths,
      title,
      theme: COVER_THEMES[selection.coverColor] ?? COVER_THEMES.giallo!,
      outputPath: draftPath,
    });

    // Rifinitura con GPT Image (COVER_AI_MODEL): la bozza montata diventa una copertina da grafico.
    // Se fallisce resta la bozza, che è già una copertina completa.
    let composedPath = draftPath;
    if (env.COVER_AI_MODEL !== "off" && chosenFaces.length > 0 && facePaths.length === chosenFaces.length) {
      try {
        const aiPeople = [];
        for (const face of chosenFaces) {
          const refs = referenceFaces(library, face, 2);
          aiPeople.push({ name: face.label ?? "", photos: await downloadFaces(refs, jobDir) });
        }
        const stylePath = path.resolve("assets", "cover-style", "modello-scritta.jpg");
        const aiPath = path.join(jobDir, "thumbnail-ai.jpg");
        await generateAiCover({
          apiKey: env.OPENAI_API_KEY,
          model: env.COVER_AI_MODEL,
          quality: env.COVER_AI_QUALITY,
          kind: isReaction ? "reaction" : "game",
          draftPath,
          backgroundPath: backgroundFullPath,
          people: aiPeople,
          title: title.toUpperCase(),
          gameName: selection.gameName ?? null,
          styleExamplePath: await fsp.access(stylePath).then(() => stylePath, () => null),
          outputPath: aiPath,
        });
        composedPath = aiPath;
      } catch (err) {
        logger.warn("Rifinitura GPT Image fallita, resta la copertina montata", { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 5) Carica la copertina generata su R2 e la imposta come thumbnail_path della clip (upgrade
    // rispetto al frame grezzo estratto al render).
    const resultStoragePath = `thumbnails/${clip.project_id}/${clip.id}-generated.jpg`;
    await storageProvider.uploadFile(composedPath, resultStoragePath, "image/jpeg");
    await supabase.from("clips").update({ thumbnail_path: resultStoragePath }).eq("id", clip.id);

    // 6) La imposta direttamente sul video YouTube già pubblicato.
    let youtubeThumbnailSet = false;
    if (credentials) {
      try {
        const result = await setYoutubeThumbnail({ credentials, videoId: publishJob.youtube_video_id, imagePath: composedPath });
        if (result.refreshedAccessToken && connectionRow) {
          await supabase
            .from("youtube_connections")
            .update({ access_token: result.refreshedAccessToken, expires_at: result.refreshedExpiresAt ?? connectionRow.expires_at })
            .eq("id", connectionRow.id);
        }
        youtubeThumbnailSet = true;
      } catch (err) {
        // Non facciamo fallire l'intero job per questo: la copertina è comunque pronta e
        // scaricabile, l'utente può impostarla a mano se l'upload automatico su YouTube fallisce.
        logger.warn("Impostazione copertina su YouTube fallita, la copertina resta comunque generata", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await updateThumbnailJobStatus(job.id, "COMPLETED", {
      result_storage_path: resultStoragePath,
      youtube_thumbnail_set: youtubeThumbnailSet,
      completed_at: new Date().toISOString(),
    });
    logger.info("Copertina generata", { jobId: job.id, clipId: clip.id, youtubeThumbnailSet });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Generazione copertina fallita", { jobId: job.id, error: message });
    await updateThumbnailJobStatus(job.id, "FAILED", { error_message: message, completed_at: new Date().toISOString() }).catch(() => undefined);
  } finally {
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function downloadImageIfOk(url: string | null, outputPath: string): Promise<string | null> {
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  await fsp.writeFile(outputPath, Buffer.from(await res.arrayBuffer()));
  return outputPath;
}

function sampleTimestamps(start: number, end: number, count: number): number[] {
  const duration = Math.max(0.1, end - start);
  const out: number[] = [];
  for (let i = 1; i <= count; i++) out.push(start + (duration * i) / (count + 1));
  return out;
}

async function grabFrame(videoPath: string, t: number, outputPath: string, longEdge?: number): Promise<string> {
  await runFfmpeg([
    "-y",
    "-ss",
    String(Math.max(0, t)),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    ...(longEdge ? ["-vf", `scale=${longEdge}:${longEdge}:force_original_aspect_ratio=decrease`] : []),
    "-q:v",
    "3",
    outputPath,
  ]);
  return outputPath;
}

/** Il titolo long-form segue già la convenzione "{ALIAS} REACTION: {argomento}" / "{ALIAS} GIOCA A {gioco}" (vedi longform-ranking.ts) — ne estrae solo la prima parte per il banner. */
function extractBannerText(title: string): string {
  const colonIndex = title.indexOf(":");
  const banner = colonIndex > 0 && colonIndex < 40 ? title.slice(0, colonIndex) : title;
  return banner.toUpperCase();
}
