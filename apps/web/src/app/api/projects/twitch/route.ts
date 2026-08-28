import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  url: z.string().trim().url("URL non valido"),
  title: z.string().trim().min(1).max(300),
  streamerName: z.string().trim().min(1).max(200),
  // Handle esatto del canale (es. "tumblurr", da followed_twitch_channels.login) — usato per
  // costruire il link corretto nel preset di descrizione di pubblicazione, non solo il nome
  // visualizzato che può differire per maiuscole/spazi.
  streamerLogin: z.string().trim().min(1).max(200).optional(),
});

/**
 * Crea un progetto "long-form" a partire da un VOD Twitch scelto dalla Feed Twitch — stessa
 * logica di /api/projects/youtube (il worker scarica il VOD con yt-dlp, che supporta Twitch
 * nativamente, senza bisogno di codice di download diverso), ma source_type='twitch_vod' e
 * streamer_name salvato subito: sono i due segnali che fanno scattare la pipeline long-form nel
 * worker (vedi process-video-job.ts) invece di quella Shorts.
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
  const { url, title, streamerName, streamerLogin } = parsed.data;

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .insert({ user_id: user.id, title, source_type: "twitch_vod", status: "UPLOADED" })
    .select()
    .single();
  if (projectError || !project) {
    return NextResponse.json({ error: `Creazione progetto fallita: ${projectError?.message}` }, { status: 500 });
  }

  const { error: videoError } = await supabase.from("videos").insert({
    project_id: project.id,
    original_filename: title,
    source_url: url,
    streamer_name: streamerName,
    streamer_login: streamerLogin ?? null,
    status: "UPLOADED",
  });
  if (videoError) {
    return NextResponse.json({ error: `Creazione video fallita: ${videoError.message}` }, { status: 500 });
  }

  return NextResponse.json({ projectId: project.id });
}
