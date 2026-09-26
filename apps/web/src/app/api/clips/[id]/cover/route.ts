import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPresignedDownloadUrl } from "@/lib/storage/r2";

/**
 * Copertina di una clip dal pulsante "Genera copertina" (long-form e Shorts): POST ne genera una
 * nuova (solo anteprima, non va su YouTube finché non si preme "Carica"), GET dice a che punto è
 * l'ultima.
 */

const bodySchema = z.object({
  /** Persone da mettere in copertina, nell'ordine (il primo è il protagonista). Vuoto = dal titolo. */
  people: z.array(z.string().trim().min(1).max(40)).max(4).optional(),
  /** Scritta scelta a mano (vince su quella dell'AI). */
  text: z.string().trim().max(40).optional(),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });

  const { data: clip } = await supabase.from("clips").select("id, status").eq("id", params.id).maybeSingle();
  if (!clip) return NextResponse.json({ error: "Clip non trovata" }, { status: 404 });
  if (clip.status !== "COMPLETED") return NextResponse.json({ error: "Prima serve il video renderizzato" }, { status: 409 });

  const people = parsed.data.people?.map((p) => p.toUpperCase());
  const text = parsed.data.text?.toUpperCase();
  const row = { clip_id: clip.id, ...(people?.length ? { cover_people: people } : {}) };
  let { data: inserted, error } = await supabase
    .from("thumbnail_jobs")
    .insert({ ...row, ...(text ? { cover_text: text } : {}) })
    .select("id")
    .single();
  // Prima della migrazione 0027 la colonna cover_text non c'è: si genera con la scritta dell'AI.
  if (error?.message.includes("cover_text")) {
    ({ data: inserted, error } = await supabase.from("thumbnail_jobs").insert(row).select("id").single());
  }
  if (error || !inserted) {
    // Prima della migrazione 0026 il link YouTube è obbligatorio.
    const hint = error?.message.includes("youtube_url") ? " (manca la migrazione 0026 su Supabase)" : "";
    return NextResponse.json({ error: `Avvio fallito${hint}: ${error?.message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId: inserted.id });
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });

  const { data: job } = await supabase
    .from("thumbnail_jobs")
    .select("id, status, error_message, result_storage_path, apply_requested, youtube_thumbnail_set")
    .eq("clip_id", params.id)
    .is("youtube_url", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!job) return NextResponse.json({ job: null });

  const url = job.result_storage_path ? await getPresignedDownloadUrl(job.result_storage_path).catch(() => null) : null;
  // Id del video su YouTube, per aprire la sua pagina di Studio (copertina verticale degli Shorts).
  const { data: published } = await supabase
    .from("youtube_publish_jobs")
    .select("youtube_video_id")
    .eq("clip_id", params.id)
    .eq("status", "COMPLETED")
    .not("youtube_video_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return NextResponse.json({
    job: {
      id: job.id,
      status: job.status,
      error: job.error_message,
      url,
      applyRequested: job.apply_requested,
      youtubeSet: job.youtube_thumbnail_set,
      youtubeVideoId: published?.youtube_video_id ?? null,
    },
  });
}
