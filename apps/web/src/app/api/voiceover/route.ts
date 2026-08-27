import { NextResponse } from "next/server";
import { z } from "zod";
import { ALLOWED_VIDEO_MIME_TYPES, ALLOWED_AUDIO_MIME_TYPES, HARD_MAX_UPLOAD_SIZE_BYTES } from "@clipforge/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPresignedUploadUrl } from "@/lib/storage/r2";

const bodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  video: z.object({
    originalFilename: z.string().min(1).max(300),
    mimeType: z.enum(ALLOWED_VIDEO_MIME_TYPES),
    sizeBytes: z.number().positive().max(HARD_MAX_UPLOAD_SIZE_BYTES),
  }),
  audio: z.object({
    originalFilename: z.string().min(1).max(300),
    mimeType: z.enum(ALLOWED_AUDIO_MIME_TYPES),
    sizeBytes: z.number().positive().max(HARD_MAX_UPLOAD_SIZE_BYTES),
  }),
});

const VIDEO_EXTENSION_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/webm": "webm",
};

const AUDIO_EXTENSION_BY_MIME: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/m4a": "m4a",
  "audio/mp4": "m4a",
};

/** Crea un job "voice over" (clip + audio caricati dall'utente, nessuna AI) e restituisce due URL firmati per l'upload diretto a R2. */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido" }, { status: 400 });
  }
  const { title, video, audio } = parsed.data;

  const { data: job, error: jobError } = await supabase
    .from("voiceover_jobs")
    .insert({
      user_id: user.id,
      title,
      video_original_filename: video.originalFilename,
      video_mime_type: video.mimeType,
      audio_original_filename: audio.originalFilename,
      status: "UPLOADING",
    })
    .select()
    .single();
  if (jobError || !job) {
    return NextResponse.json({ error: `Creazione job fallita: ${jobError?.message}` }, { status: 500 });
  }

  const videoExtension = VIDEO_EXTENSION_BY_MIME[video.mimeType] ?? "mp4";
  const audioExtension = AUDIO_EXTENSION_BY_MIME[audio.mimeType] ?? "mp3";
  const videoStoragePath = `voiceover-uploads/${user.id}/${job.id}/video.${videoExtension}`;
  const audioStoragePath = `voiceover-uploads/${user.id}/${job.id}/audio.${audioExtension}`;

  let videoUploadUrl: string;
  let audioUploadUrl: string;
  try {
    [videoUploadUrl, audioUploadUrl] = await Promise.all([
      getPresignedUploadUrl(videoStoragePath, video.mimeType),
      getPresignedUploadUrl(audioStoragePath, audio.mimeType),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Generazione URL di upload fallita: ${message}` }, { status: 500 });
  }

  const { error: updateError } = await supabase
    .from("voiceover_jobs")
    .update({ video_storage_path: videoStoragePath, audio_storage_path: audioStoragePath })
    .eq("id", job.id);
  if (updateError) {
    return NextResponse.json({ error: `Aggiornamento job fallito: ${updateError.message}` }, { status: 500 });
  }

  return NextResponse.json({ jobId: job.id, videoUploadUrl, audioUploadUrl });
}
