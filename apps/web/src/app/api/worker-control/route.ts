import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({ paused: z.boolean() });

/**
 * Controllo globale pausa/ripresa del worker locale — riga singola in worker_control, letta dal
 * worker ogni pochi secondi (vedi apps/worker/src/pipeline/pause-control-loop.ts). Non è per
 * singolo progetto: mette in pausa/riprende TUTTO quello che il worker sta facendo in quel momento.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const { data, error } = await supabase.from("worker_control").select("paused, updated_at").eq("id", true).single();
  if (error || !data) {
    return NextResponse.json({ error: "Stato worker non trovato" }, { status: 500 });
  }
  return NextResponse.json(data);
}

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

  const { error } = await supabase
    .from("worker_control")
    .update({ paused: parsed.data.paused, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (error) {
    return NextResponse.json({ error: `Aggiornamento fallito: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, paused: parsed.data.paused });
}
