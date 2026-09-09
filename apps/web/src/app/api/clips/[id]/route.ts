import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildLongformDescription } from "@/lib/longform-description";

/**
 * La descrizione che verrebbe usata senza nessuna modifica a mano: per il long-form il preset fisso
 * di crediti allo streamer, per gli Shorts la caption scritta dall'IA. Stessa regola di
 * schedule-batch, tenuta qui per poterla riapplicare quando l'utente svuota il campo.
 */
async function autoDescriptionFor(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  clip: { caption: string | null; format: string; video_id: string },
): Promise<string> {
  if (clip.format !== "longform") return clip.caption ?? "";
  const { data: video } = await supabase
    .from("videos")
    .select("streamer_name, streamer_login")
    .eq("id", clip.video_id)
    .maybeSingle();
  if (!video?.streamer_name) return clip.caption ?? "";
  return buildLongformDescription(video.streamer_name, video.streamer_login);
}

const bodySchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  // Stringa vuota = "torna al testo generato automaticamente" (salvata come NULL).
  publishDescription: z.string().max(5000).optional(),
  hashtags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
});

/**
 * Salva titolo, descrizione e hashtag scritti a mano su una clip.
 *
 * Aggiorna anche i job di pubblicazione GIA' PROGRAMMATI ma non ancora partiti: la
 * programmazione copia i testi sul job nel momento in cui la si crea (vedi schedule-batch), quindi
 * senza questo passaggio una modifica fatta dopo aver programmato non sarebbe arrivata su YouTube —
 * che e' esattamente il caso da cui nasce questa funzione. I job gia' caricati (UPLOADING,
 * COMPLETED) non si toccano: il video e' gia' su YouTube e andrebbe cambiato da li'.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
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
  const { title, publishDescription, hashtags } = parsed.data;
  if (title === undefined && publishDescription === undefined && hashtags === undefined) {
    return NextResponse.json({ error: "Niente da aggiornare" }, { status: 400 });
  }

  const clipUpdate: { title?: string; hashtags?: string[]; publish_description?: string | null } = {};
  if (title !== undefined) clipUpdate.title = title;
  if (hashtags !== undefined) clipUpdate.hashtags = hashtags;
  if (publishDescription !== undefined) {
    const trimmed = publishDescription.trim();
    clipUpdate.publish_description = trimmed.length > 0 ? trimmed : null;
  }

  // La RLS (clips_update_own) limita gia' l'aggiornamento alle clip dell'utente: se la clip non e'
  // sua, non viene aggiornata nessuna riga.
  const { data: updated, error: updateError } = await supabase
    .from("clips")
    .update(clipUpdate)
    .eq("id", params.id)
    .select("id, title, caption, hashtags, publish_description, format, video_id")
    .maybeSingle();
  if (updateError) {
    return NextResponse.json({ error: `Salvataggio fallito: ${updateError.message}` }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "Clip non trovata" }, { status: 404 });
  }

  const jobUpdate: { title?: string; tags?: string[]; description?: string } = {};
  if (title !== undefined) jobUpdate.title = updated.title.slice(0, 100);
  // `hashtags` è una colonna jsonb, quindi il tipo generato è `unknown`: qui sappiamo che ci
  // abbiamo appena scritto un array di stringhe.
  if (hashtags !== undefined) jobUpdate.tags = (updated.hashtags as string[] | null) ?? [];
  if (publishDescription !== undefined) {
    // Svuotare il campo significa "torna al testo automatico": il job programmato deve tornarci
    // anche lui, altrimenti resterebbe con la vecchia descrizione scritta a mano.
    jobUpdate.description = updated.publish_description ?? (await autoDescriptionFor(supabase, updated));
  }

  let pendingJobsUpdated = 0;
  if (Object.keys(jobUpdate).length > 0) {
    const { data: jobs, error: jobsError } = await supabase
      .from("youtube_publish_jobs")
      .update(jobUpdate)
      .eq("clip_id", params.id)
      .eq("status", "PENDING")
      .is("cancelled_at", null)
      .select("id");
    if (jobsError) {
      return NextResponse.json(
        { error: `Clip salvata, ma l'aggiornamento della programmazione è fallito: ${jobsError.message}` },
        { status: 500 },
      );
    }
    pendingJobsUpdated = jobs?.length ?? 0;
  }

  return NextResponse.json({ ok: true, pendingJobsUpdated });
}
