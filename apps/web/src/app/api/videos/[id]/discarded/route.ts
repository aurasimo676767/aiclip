import { NextResponse } from "next/server";
import { z } from "zod";
import type { DiscardedShort } from "@clipforge/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({ start: z.number(), title: z.string() });

/**
 * Recupera uno Short che l'AI aveva scartato: crea la clip già pronta (salvata dal worker in
 * videos.discarded_shorts), la mette in render e la toglie dalla lista degli scartati.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });

  const { data: video, error: videoError } = await supabase.from("videos").select("id, discarded_shorts").eq("id", params.id).maybeSingle();
  if (videoError) {
    const missing = videoError.message.includes("discarded_shorts");
    return NextResponse.json({ error: missing ? "Serve la migrazione 0034 su Supabase" : videoError.message }, { status: 500 });
  }
  if (!video) return NextResponse.json({ error: "Video non trovato" }, { status: 404 });

  const items = (video.discarded_shorts as DiscardedShort[] | null) ?? [];
  const index = items.findIndex((d) => d.start === parsed.data.start && d.title === parsed.data.title);
  if (index === -1) return NextResponse.json({ error: "Short già recuperato o non più presente" }, { status: 409 });

  const { data: clip, error: insertError } = await supabase
    .from("clips")
    .insert({ ...(items[index]!.row as object), status: "QUEUED" } as never)
    .select("id")
    .single();
  if (insertError || !clip) {
    const noPolicy = insertError?.message.includes("row-level security");
    return NextResponse.json({ error: noPolicy ? "Serve la migrazione 0034 su Supabase" : `Creazione clip fallita: ${insertError?.message}` }, { status: 500 });
  }

  const { error: renderError } = await supabase.from("render_jobs").insert({ clip_id: clip.id });
  if (renderError) return NextResponse.json({ error: `Creazione render job fallita: ${renderError.message}` }, { status: 500 });

  await supabase
    .from("videos")
    .update({ discarded_shorts: items.filter((_, i) => i !== index) as never })
    .eq("id", params.id);

  return NextResponse.json({ ok: true, clipId: clip.id });
}
