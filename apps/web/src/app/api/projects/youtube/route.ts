import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const YOUTUBE_URL_PATTERN = /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)/i;

const bodySchema = z.object({
  url: z
    .string()
    .trim()
    .url("URL non valido")
    .refine((url) => YOUTUBE_URL_PATTERN.test(url), "Deve essere un link YouTube (youtube.com o youtu.be)"),
});

/**
 * Crea un progetto a partire da un URL YouTube. A differenza dell'upload file, qui non
 * serve alcuna interazione con lo Storage lato web: il worker scarica il video (yt-dlp),
 * lo carica su Storage lui stesso e aggiorna titolo/durata reali una volta ottenuti.
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
  const { url } = parsed.data;

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .insert({ user_id: user.id, title: "Importazione da YouTube...", source_type: "youtube_url", status: "UPLOADED" })
    .select()
    .single();
  if (projectError || !project) {
    return NextResponse.json({ error: `Creazione progetto fallita: ${projectError?.message}` }, { status: 500 });
  }

  const { error: videoError } = await supabase.from("videos").insert({
    project_id: project.id,
    original_filename: url,
    source_url: url,
    status: "UPLOADED",
  });
  if (videoError) {
    return NextResponse.json({ error: `Creazione video fallita: ${videoError.message}` }, { status: 500 });
  }

  return NextResponse.json({ projectId: project.id });
}
