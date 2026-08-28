import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(5000).default(""),
  tags: z.array(z.string().trim().min(1).max(30)).max(30).default([]),
  privacyStatus: z.enum(["public", "unlisted", "private"]).default("public"),
  // ISO 8601, deve cadere nel futuro: YouTube rifiuta un publishAt nel passato o troppo vicino.
  publishAt: z
    .string()
    .datetime()
    .refine((v) => new Date(v).getTime() > Date.now() + 60_000, "La data di programmazione deve essere nel futuro")
    .nullable()
    .optional(),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
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
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido" }, { status: 400 });
  }

  const { data: clip, error: clipError } = await supabase.from("clips").select("id, status, format").eq("id", params.id).single();
  if (clipError || !clip) {
    return NextResponse.json({ error: "Clip non trovata" }, { status: 404 });
  }
  if (clip.status !== "COMPLETED") {
    return NextResponse.json({ error: "La clip deve essere renderizzata prima di poter essere pubblicata" }, { status: 409 });
  }

  const { data: connection } = await supabase.from("youtube_connections").select("id").eq("user_id", user.id).maybeSingle();
  if (!connection) {
    return NextResponse.json({ error: "Collega prima un account YouTube dalle Impostazioni" }, { status: 409 });
  }

  const { title, description, tags, privacyStatus, publishAt } = parsed.data;

  // Long-form: mai pubblicazione automatica (manca ancora un modo per generare la miniatura) —
  // si carica solo come privato, senza programmazione, e si finisce tutto a mano su YouTube
  // Studio. Non ci si fida del solo valore mandato dal client per questo.
  const isLongform = clip.format === "longform";

  const { error: insertError } = await supabase.from("youtube_publish_jobs").insert({
    clip_id: clip.id,
    title,
    description,
    tags,
    // YouTube richiede "private" quando si programma: il worker lo forza comunque lato suo,
    // ma teniamo coerente anche il valore salvato qui.
    privacy_status: isLongform ? "private" : publishAt ? "private" : privacyStatus,
    publish_at: isLongform ? null : (publishAt ?? null),
  });
  if (insertError) {
    return NextResponse.json({ error: `Creazione job di pubblicazione fallita: ${insertError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
