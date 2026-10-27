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
  /** Istruzioni libere per l'AI (gioco, scritte, stile): vincono sulle regole standard. */
  instructions: z.string().trim().max(1000).optional(),
  /** "Modifica": la copertina già fatta da ritoccare (id del suo job) e cosa cambiare. */
  editOf: z.string().uuid().optional(),
  edit: z.string().trim().min(2).max(500).optional(),
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

  // Ritocco di una copertina già fatta (simo, 2026-10-27): il worker la riconosce dal prefisso nelle
  // istruzioni e manda all'AI solo quella (~2 centesimi invece di 10-15, vedi editCover nel worker).
  if (parsed.data.editOf) {
    if (!parsed.data.edit) return NextResponse.json({ error: "Scrivi cosa cambiare" }, { status: 400 });
    const { data: base } = await supabase
      .from("thumbnail_jobs")
      .select("id, result_storage_path")
      .eq("id", parsed.data.editOf)
      .eq("clip_id", clip.id)
      .maybeSingle();
    if (!base?.result_storage_path) return NextResponse.json({ error: "Copertina da modificare non trovata" }, { status: 404 });
    const { data: editJob, error: editError } = await supabase
      .from("thumbnail_jobs")
      .insert({ clip_id: clip.id, cover_instructions: `[modifica:${base.id}] ${parsed.data.edit}` })
      .select("id")
      .single();
    if (editError || !editJob) return NextResponse.json({ error: `Avvio fallito: ${editError?.message}` }, { status: 500 });
    return NextResponse.json({ ok: true, jobId: editJob.id });
  }

  const people = parsed.data.people?.map((p) => p.toUpperCase());
  const text = parsed.data.text?.toUpperCase();
  const row = { clip_id: clip.id, ...(people?.length ? { cover_people: people } : {}) };
  let { data: inserted, error } = await supabase
    .from("thumbnail_jobs")
    .insert({ ...row, ...(text ? { cover_text: text } : {}), ...(parsed.data.instructions ? { cover_instructions: parsed.data.instructions } : {}) })
    .select("id")
    .single();
  if (error?.message.includes("cover_instructions")) {
    return NextResponse.json({ error: "Per le istruzioni serve la migrazione 0033 su Supabase" }, { status: 500 });
  }
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

  const columns = "id, status, error_message, result_storage_path, apply_requested, youtube_thumbnail_set, cover_instructions";
  const { data: latest } = await supabase
    .from("thumbnail_jobs")
    .select(columns)
    .eq("clip_id", params.id)
    .is("youtube_url", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) return NextResponse.json({ job: null });
  // Una modifica non riuscita non deve far sparire la copertina da cui partiva (simo, 2026-10-27:
  // "mi ha tolto la copertina che c'era"): si mostra l'ultima riuscita, con l'errore della modifica.
  let job = latest;
  let editError: string | null = null;
  if (latest.status === "FAILED" && latest.cover_instructions?.startsWith("[modifica:")) {
    const { data: done } = await supabase
      .from("thumbnail_jobs")
      .select(columns)
      .eq("clip_id", params.id)
      .is("youtube_url", null)
      .eq("status", "COMPLETED")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (done) {
      job = done;
      editError = latest.error_message ?? "errore sconosciuto";
    }
  }

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
      editError,
      url,
      applyRequested: job.apply_requested,
      youtubeSet: job.youtube_thumbnail_set,
      youtubeVideoId: published?.youtube_video_id ?? null,
    },
  });
}
