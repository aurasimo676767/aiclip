import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const CANCEL_MESSAGE = "Annullato dall'utente";

/**
 * Annulla un video/progetto la cui pipeline di analisi (download/trascrizione/AI) è ancora in
 * corso: marca subito status=FAILED (così la dashboard riflette l'annullamento all'istante) e
 * imposta cancel_requested=true, che il worker controlla tra uno stadio e l'altro per smettere
 * di lavorarci senza sovrascrivere questo stato.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const { data: video, error: videoError } = await supabase
    .from("videos")
    .select("id, status")
    .eq("project_id", params.id)
    .maybeSingle();
  if (videoError || !video) {
    return NextResponse.json({ error: "Video non trovato" }, { status: 404 });
  }
  if (video.status === "READY" || video.status === "FAILED") {
    return NextResponse.json({ error: "Il video non è in elaborazione" }, { status: 409 });
  }

  const { error: updateVideoError } = await supabase
    .from("videos")
    .update({ status: "FAILED", error_message: CANCEL_MESSAGE, cancel_requested: true })
    .eq("id", video.id);
  if (updateVideoError) {
    return NextResponse.json({ error: `Annullamento fallito: ${updateVideoError.message}` }, { status: 500 });
  }

  const { error: updateProjectError } = await supabase
    .from("projects")
    .update({ status: "FAILED", error_message: CANCEL_MESSAGE })
    .eq("id", params.id);
  if (updateProjectError) {
    return NextResponse.json({ error: `Annullamento progetto fallito: ${updateProjectError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
