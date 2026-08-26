import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const YOUTUBE_URL_PATTERN = /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)/i;
const MAX_URLS_PER_BATCH = 15;

const bodySchema = z.object({
  urls: z.array(z.string().trim().min(1)).min(1).max(MAX_URLS_PER_BATCH),
});

/**
 * Come /api/projects/youtube ma per più link insieme: crea un progetto+video per ogni URL
 * valido (stessa identica logica, solo in un ciclo), così il worker li elabora tutti in
 * parallelo/in coda senza dover incollare i link uno alla volta. Un URL non valido non blocca
 * gli altri: torna nella lista "errors" invece di far fallire l'intera richiesta.
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

  // Dedupe preservando l'ordine di inserimento.
  const urls = [...new Set(parsed.data.urls.map((u) => u.trim()).filter(Boolean))];

  const projectIds: string[] = [];
  const errors: Array<{ url: string; error: string }> = [];

  for (const url of urls) {
    if (!YOUTUBE_URL_PATTERN.test(url)) {
      errors.push({ url, error: "Non è un link YouTube valido" });
      continue;
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .insert({
        user_id: user.id,
        title: "Importazione da YouTube...",
        source_type: "youtube_url",
        status: "UPLOADED",
        // Genera più video: le clip suggerite vengono messe in render subito, senza selezione
        // manuale (vedi process-video-job.ts) — a differenza dell'import singolo.
        auto_generate_clips: true,
      })
      .select()
      .single();
    if (projectError || !project) {
      errors.push({ url, error: `Creazione progetto fallita: ${projectError?.message}` });
      continue;
    }

    const { error: videoError } = await supabase.from("videos").insert({
      project_id: project.id,
      original_filename: url,
      source_url: url,
      status: "UPLOADED",
    });
    if (videoError) {
      errors.push({ url, error: `Creazione video fallita: ${videoError.message}` });
      continue;
    }

    projectIds.push(project.id);
  }

  return NextResponse.json({ projectIds, errors });
}
