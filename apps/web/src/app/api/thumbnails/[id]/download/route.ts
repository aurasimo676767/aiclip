import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPresignedDownloadUrl } from "@/lib/storage/r2";

/**
 * Scarica la copertina come file (copertina.jpg). Serve per gli Shorts: la copertina verticale del
 * canale YouTube si carica solo a mano da Studio, quindi il file deve finire nei download. Il link
 * diretto a R2 apre l'immagine invece di scaricarla (è di un altro dominio).
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });

  const { data: job } = await supabase.from("thumbnail_jobs").select("id, result_storage_path").eq("id", params.id).maybeSingle();
  if (!job?.result_storage_path) return NextResponse.json({ error: "Copertina non trovata" }, { status: 404 });

  const res = await fetch(await getPresignedDownloadUrl(job.result_storage_path));
  if (!res.ok) return NextResponse.json({ error: "Download fallito" }, { status: 502 });
  return new NextResponse(res.body, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Disposition": `attachment; filename="copertina-${job.id.slice(0, 8)}.jpg"`,
    },
  });
}
