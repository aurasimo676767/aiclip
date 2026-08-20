import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({ clipIds: z.array(z.string().uuid()).min(1).max(50) });

/**
 * Crea i render_jobs per le clip selezionate. La RLS su render_jobs (insert)
 * verifica che la clip appartenga a un progetto dell'utente autenticato: se un
 * clipId non è suo, l'insert per quella riga fallisce a livello di database.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Payload non valido" }, { status: 400 });
  }

  const { clipIds } = parsed.data;

  const { error: insertError } = await supabase.from("render_jobs").insert(clipIds.map((clip_id) => ({ clip_id })));
  if (insertError) {
    return NextResponse.json({ error: `Creazione render job fallita: ${insertError.message}` }, { status: 500 });
  }

  const { error: updateError } = await supabase.from("clips").update({ status: "QUEUED" }).in("id", clipIds);
  if (updateError) {
    return NextResponse.json({ error: `Aggiornamento clip fallito: ${updateError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, count: clipIds.length });
}
