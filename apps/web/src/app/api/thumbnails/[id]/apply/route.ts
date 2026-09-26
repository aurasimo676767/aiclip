import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * "Carica": approva la copertina generata. Il job torna in coda e il worker la imposta sul video
 * se è già su YouTube, e la salva nella clip così la pubblicazione la usa.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });

  const { data: job } = await supabase.from("thumbnail_jobs").select("id, status, result_storage_path").eq("id", params.id).maybeSingle();
  if (!job) return NextResponse.json({ error: "Copertina non trovata" }, { status: 404 });
  if (job.status !== "COMPLETED" || !job.result_storage_path) {
    return NextResponse.json({ error: "La copertina non è ancora pronta" }, { status: 409 });
  }

  const { data: updated, error } = await supabase
    .from("thumbnail_jobs")
    .update({ apply_requested: true, status: "PENDING", claimed_by: null, claimed_at: null, error_message: null, completed_at: null })
    .eq("id", job.id)
    .select("id");
  if (error) return NextResponse.json({ error: `Caricamento fallito: ${error.message}` }, { status: 500 });
  // Senza la policy di aggiornamento (migrazione 0026) Supabase non aggiorna niente e non dà errore.
  if (!updated?.length) return NextResponse.json({ error: "Caricamento non permesso: manca la migrazione 0026 su Supabase" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
