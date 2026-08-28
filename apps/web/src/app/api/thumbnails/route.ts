import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  youtubeUrl: z.string().trim().min(1),
  // Link del video ORIGINALE reagito, incollato a mano quando lo si conosce: scavalca del tutto
  // il tentativo automatico (l'IA che legge titolo/canale dai fotogrammi + ricerca), che a volte
  // non trova nulla o trova il video sbagliato.
  reactedVideoUrl: z.string().trim().min(1).optional(),
});

/** Estrae l'id video da un URL YouTube in uno dei formati comuni (watch?v=, youtu.be/, shorts/). */
function extractYoutubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  const patterns = [/[?&]v=([a-zA-Z0-9_-]{11})/, /youtu\.be\/([a-zA-Z0-9_-]{11})/, /\/shorts\/([a-zA-Z0-9_-]{11})/];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1]!;
  }
  // Se hanno incollato direttamente l'id nudo (11 caratteri, nessuno slash/query).
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Crea un job di generazione copertina a partire dal link YouTube di un video long-form GIÀ
 * pubblicato da ClipForge — non accetta un link qualsiasi: risale alla clip tramite
 * youtube_publish_jobs.youtube_video_id (impostato dal worker all'upload), così eredita gratis
 * tutto il contesto già disponibile (titolo con alias, hook, descrizione) invece di dover
 * chiedere altro all'utente.
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

  const videoId = extractYoutubeVideoId(parsed.data.youtubeUrl);
  if (!videoId) {
    return NextResponse.json({ error: "Link YouTube non riconosciuto" }, { status: 400 });
  }

  const { data: publishJob, error: publishJobError } = await supabase
    .from("youtube_publish_jobs")
    .select("clip_id, clips(format)")
    .eq("youtube_video_id", videoId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (publishJobError || !publishJob) {
    return NextResponse.json({ error: "Questo link non risulta pubblicato da ClipForge" }, { status: 404 });
  }

  const publishJobTyped = publishJob as unknown as { clip_id: string; clips: { format: string } | { format: string }[] | null };
  const clipFormat = Array.isArray(publishJobTyped.clips) ? publishJobTyped.clips[0]?.format : publishJobTyped.clips?.format;
  if (clipFormat !== "longform") {
    return NextResponse.json({ error: "La generazione copertine è disponibile solo per i video long-form" }, { status: 400 });
  }

  const { data: inserted, error: insertError } = await supabase
    .from("thumbnail_jobs")
    .insert({
      clip_id: publishJobTyped.clip_id,
      youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
      reacted_video_url: parsed.data.reactedVideoUrl ?? null,
    })
    .select("id")
    .single();
  if (insertError || !inserted) {
    return NextResponse.json({ error: `Creazione job fallita: ${insertError?.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, jobId: inserted.id });
}
