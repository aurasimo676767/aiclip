import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const CANCEL_MESSAGE = "Annullato dall'utente";

/**
 * Annulla il render in corso (o in coda) di una clip: marca subito render_job/clip come
 * FAILED e imposta cancel_requested=true, che il worker controlla tra uno stadio e l'altro
 * del render (download sorgente / ffmpeg / upload) per smettere di lavorarci.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const { data: clip, error: clipError } = await supabase
    .from("clips")
    .select("id, status")
    .eq("id", params.id)
    .maybeSingle();
  if (clipError || !clip) {
    return NextResponse.json({ error: "Clip non trovata" }, { status: 404 });
  }
  if (clip.status !== "QUEUED" && clip.status !== "RENDERING") {
    return NextResponse.json({ error: "La clip non è in rendering" }, { status: 409 });
  }

  const { data: renderJob, error: renderJobError } = await supabase
    .from("render_jobs")
    .select("id")
    .eq("clip_id", clip.id)
    .in("status", ["PENDING", "RENDERING"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (renderJobError || !renderJob) {
    return NextResponse.json({ error: "Render job non trovato" }, { status: 404 });
  }

  const { error: updateJobError } = await supabase
    .from("render_jobs")
    .update({ status: "FAILED", error_message: CANCEL_MESSAGE, cancel_requested: true, completed_at: new Date().toISOString() })
    .eq("id", renderJob.id);
  if (updateJobError) {
    return NextResponse.json({ error: `Annullamento fallito: ${updateJobError.message}` }, { status: 500 });
  }

  const { error: updateClipError } = await supabase
    .from("clips")
    .update({ status: "FAILED", error_message: CANCEL_MESSAGE })
    .eq("id", clip.id);
  if (updateClipError) {
    return NextResponse.json({ error: `Annullamento clip fallito: ${updateClipError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
