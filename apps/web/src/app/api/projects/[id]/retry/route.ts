import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Rimette in coda un video/progetto la cui pipeline di analisi (trascrizione + AI) è fallita:
 * riporta lo stato a UPLOADED (ripreso da claim_next_video) e azzera error_message/claim/attempts,
 * così un job bloccato per max_attempts non viene subito rimarcato FAILED al primo blip di rete.
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
  if (video.status !== "FAILED") {
    return NextResponse.json({ error: "Il video non è in stato di errore" }, { status: 409 });
  }

  const { error: updateVideoError } = await supabase
    .from("videos")
    .update({ status: "UPLOADED", error_message: null, claimed_by: null, claimed_at: null, attempts: 0 })
    .eq("id", video.id);
  if (updateVideoError) {
    return NextResponse.json({ error: `Aggiornamento video fallito: ${updateVideoError.message}` }, { status: 500 });
  }

  const { error: updateProjectError } = await supabase
    .from("projects")
    .update({ status: "UPLOADED", error_message: null })
    .eq("id", params.id);
  if (updateProjectError) {
    return NextResponse.json({ error: `Aggiornamento progetto fallito: ${updateProjectError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
