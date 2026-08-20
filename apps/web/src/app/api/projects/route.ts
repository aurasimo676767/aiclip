import { NextResponse } from "next/server";
import { z } from "zod";
import { ALLOWED_VIDEO_MIME_TYPES, HARD_MAX_UPLOAD_SIZE_BYTES, PLAN_LIMITS, type Plan } from "@clipforge/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPresignedUploadUrl } from "@/lib/storage/r2";

const bodySchema = z.object({
  title: z.string().trim().min(1, "Il titolo è obbligatorio").max(200),
  originalFilename: z.string().min(1).max(300),
  mimeType: z.enum(ALLOWED_VIDEO_MIME_TYPES),
  sizeBytes: z
    .number()
    .positive()
    .max(HARD_MAX_UPLOAD_SIZE_BYTES, "File troppo grande"),
});

const EXTENSION_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/webm": "webm",
};

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
  const { title, originalFilename, mimeType, sizeBytes } = parsed.data;

  const { data: profile, error: profileError } = await supabase.from("profiles").select("plan").eq("id", user.id).single();
  if (profileError || !profile) {
    return NextResponse.json({ error: "Profilo utente non trovato" }, { status: 500 });
  }

  const planLimit = PLAN_LIMITS[profile.plan as Plan].maxUploadSizeBytes;
  if (sizeBytes > planLimit) {
    return NextResponse.json(
      { error: `Il file supera il limite del piano ${profile.plan} (${Math.round(planLimit / 1024 / 1024)}MB)` },
      { status: 413 },
    );
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .insert({ user_id: user.id, title, source_type: "upload", status: "UPLOADING" })
    .select()
    .single();
  if (projectError || !project) {
    return NextResponse.json({ error: `Creazione progetto fallita: ${projectError?.message}` }, { status: 500 });
  }

  const { data: video, error: videoError } = await supabase
    .from("videos")
    .insert({
      project_id: project.id,
      original_filename: originalFilename,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      status: "UPLOADING",
    })
    .select()
    .single();
  if (videoError || !video) {
    return NextResponse.json({ error: `Creazione video fallita: ${videoError?.message}` }, { status: 500 });
  }

  const extension = EXTENSION_BY_MIME[mimeType] ?? "mp4";
  const storagePath = `videos/${user.id}/${video.id}/source.${extension}`;

  let uploadUrl: string;
  try {
    uploadUrl = await getPresignedUploadUrl(storagePath, mimeType);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Generazione URL di upload fallita: ${message}` }, { status: 500 });
  }

  const { error: updateError } = await supabase.from("videos").update({ storage_path: storagePath }).eq("id", video.id);
  if (updateError) {
    return NextResponse.json({ error: `Aggiornamento video fallito: ${updateError.message}` }, { status: 500 });
  }

  return NextResponse.json({
    projectId: project.id,
    videoId: video.id,
    uploadUrl,
  });
}
