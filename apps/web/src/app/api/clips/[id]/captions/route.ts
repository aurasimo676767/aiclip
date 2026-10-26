import { NextResponse } from "next/server";
import { z } from "zod";
import { captionSettingsSchema } from "@clipforge/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({ settings: captionSettingsSchema });

/**
 * Applica uno stile dei sottotitoli a UNO Short: lo salva sulla clip e mette in coda un render
 * "captions", che riusa la regia del render precedente (inquadrature, regia del gioco) senza
 * chiamare l'AI: gratis, circa un minuto e mezzo sul PC.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Stile non valido" }, { status: 400 });

  const { data: clip } = await supabase.from("clips").select("id, status, format").eq("id", params.id).maybeSingle();
  if (!clip) return NextResponse.json({ error: "Short non trovato" }, { status: 404 });
  if (clip.format === "longform") return NextResponse.json({ error: "Gli stili dei sottotitoli sono solo per gli Shorts" }, { status: 400 });
  if (clip.status === "QUEUED" || clip.status === "RENDERING") {
    return NextResponse.json({ error: "Lo Short è già in render: aspetta che finisca e riprova" }, { status: 409 });
  }

  const { error: saveError } = await supabase.from("clips").update({ caption_settings: parsed.data.settings, status: "QUEUED", error_message: null }).eq("id", clip.id);
  if (saveError) return NextResponse.json({ error: `Stile non salvato: ${saveError.message}` }, { status: 500 });

  const { error: jobError } = await supabase.from("render_jobs").insert({ clip_id: clip.id, mode: "captions" });
  if (jobError) {
    await supabase.from("clips").update({ status: clip.status }).eq("id", clip.id);
    return NextResponse.json({ error: `Render non messo in coda: ${jobError.message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
