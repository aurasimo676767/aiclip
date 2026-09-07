import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const MAX_VODS_PER_BATCH = 60; // ~2 mesi di VOD anche per un canale molto attivo, con margine

const bodySchema = z.object({
  videos: z
    .array(
      z.object({
        url: z.string().trim().url(),
        title: z.string().trim().min(1).max(300),
        streamerName: z.string().trim().min(1).max(200),
        streamerLogin: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .min(1)
    .max(MAX_VODS_PER_BATCH),
});

/**
 * Come /api/projects/twitch ma per generare TUTTI i VOD di un canale in un colpo solo (vedi
 * dashboard/feed/twitch/[id]) — un progetto+video per ognuno, stessa logica dell'import singolo
 * ripetuta in un ciclo. Un VOD che fallisce non blocca gli altri.
 */
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

  const projectIds: string[] = [];
  const errors: Array<{ url: string; error: string }> = [];

  for (const video of parsed.data.videos) {
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .insert({ user_id: user.id, title: video.title, source_type: "twitch_vod", status: "UPLOADED" })
      .select()
      .single();
    if (projectError || !project) {
      errors.push({ url: video.url, error: `Creazione progetto fallita: ${projectError?.message}` });
      continue;
    }

    const { error: videoError } = await supabase.from("videos").insert({
      project_id: project.id,
      original_filename: video.title,
      source_url: video.url,
      streamer_name: video.streamerName,
      streamer_login: video.streamerLogin ?? null,
      status: "UPLOADED",
    });
    if (videoError) {
      errors.push({ url: video.url, error: `Creazione video fallita: ${videoError.message}` });
      continue;
    }

    projectIds.push(project.id);
  }

  return NextResponse.json({ projectIds, errors });
}
