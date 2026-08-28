import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPresignedDownloadUrl } from "@/lib/storage/r2";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const { data: job, error: jobError } = await supabase
    .from("thumbnail_jobs")
    .select("id, status, result_storage_path")
    .eq("id", params.id)
    .single();
  if (jobError || !job) {
    return NextResponse.json({ error: "Job non trovato" }, { status: 404 });
  }
  if (job.status !== "COMPLETED" || !job.result_storage_path) {
    return NextResponse.json({ error: "Copertina non ancora pronta" }, { status: 409 });
  }

  try {
    const url = await getPresignedDownloadUrl(job.result_storage_path);
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Generazione URL fallita: ${message}` }, { status: 500 });
  }
}
