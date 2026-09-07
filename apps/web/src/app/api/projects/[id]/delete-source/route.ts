import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Segna il video di questo progetto per la cancellazione manuale del sorgente (R2 + cache locale
 * del worker) — vedi cleanup-source.ts nel worker, che esegue davvero la cancellazione al
 * prossimo giro di polling. Non fa nulla di distruttivo qui: solo scrive il flag.
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
    .select("id")
    .eq("project_id", params.id)
    .maybeSingle();
  if (videoError || !video) {
    return NextResponse.json({ error: "Video non trovato" }, { status: 404 });
  }

  const { error: updateError } = await supabase
    .from("videos")
    .update({ delete_source_requested_at: new Date().toISOString() })
    .eq("id", video.id);
  if (updateError) {
    return NextResponse.json({ error: `Richiesta di cancellazione fallita: ${updateError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
