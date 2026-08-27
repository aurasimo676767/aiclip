import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Segna il job come pronto per il worker, dopo che ENTRAMBI i file (video + audio) sono stati caricati su R2. */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const { data: job, error: jobError } = await supabase
    .from("voiceover_jobs")
    .select("id, status")
    .eq("id", params.id)
    .single();
  if (jobError || !job) {
    return NextResponse.json({ error: "Job non trovato" }, { status: 404 });
  }
  if (job.status !== "UPLOADING") {
    return NextResponse.json({ error: "Il job non è in attesa di upload" }, { status: 409 });
  }

  const { error: updateError } = await supabase.from("voiceover_jobs").update({ status: "PENDING" }).eq("id", params.id);
  if (updateError) {
    return NextResponse.json({ error: `Aggiornamento job fallito: ${updateError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
