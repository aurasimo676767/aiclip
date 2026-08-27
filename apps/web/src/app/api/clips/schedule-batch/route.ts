import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const MIN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h
const MAX_INTERVAL_MS = 2.5 * 60 * 60 * 1000; // 2h30
const MAX_CLIPS_PER_BATCH = 20;

const bodySchema = z.object({ clipIds: z.array(z.string().uuid()).min(1).max(MAX_CLIPS_PER_BATCH) });

function randomIntervalMs(): number {
  return MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
}

/**
 * Trova il prossimo slot valido da `cursor` in poi, rispettando un minimo di
 * MIN_INTERVAL_MS da qualunque slot GIÀ programmato (`existingSorted`, ordinato crescente,
 * solo slot futuri). Se il candidato cade troppo vicino a uno slot esistente, non lo scarta e
 * basta: usa quello slot esistente come nuovo `cursor` e riprova — così i nuovi slot riempiono
 * per prime le finestre LIBERE più vicine ad ora, invece di accodarsi sempre dopo l'ultimo
 * slot esistente (che poteva anche essere lontanissimo nel futuro, lasciando ore vuote prima).
 */
function pickNextSlot(cursor: number, existingSorted: number[]): number {
  const candidate = cursor + randomIntervalMs();
  for (const existing of existingSorted) {
    if (existing < cursor) continue; // già superato, non è più un vincolo
    if (Math.abs(candidate - existing) < MIN_INTERVAL_MS) {
      return pickNextSlot(existing, existingSorted);
    }
    if (existing > candidate) break; // ordinati: i successivi sono ancora più lontani, nessun altro conflitto possibile
  }
  return candidate;
}

/**
 * Programma automaticamente più clip in fila su YouTube, distanziate 2h-2h30 l'una dall'altra
 * (variabile per non essere un pattern troppo riconoscibile) — riempie prima le finestre
 * libere più vicine ad ora, saltando oltre uno slot già programmato solo se ci si arriva
 * davvero vicino (vedi pickNextSlot), invece di accodarsi sempre dopo l'ultimo slot esistente.
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
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido" }, { status: 400 });
  }
  const { clipIds } = parsed.data;

  const { data: connection } = await supabase.from("youtube_connections").select("id").eq("user_id", user.id).maybeSingle();
  if (!connection) {
    return NextResponse.json({ error: "Collega prima un account YouTube dalle Impostazioni" }, { status: 409 });
  }

  const { data: clips, error: clipsError } = await supabase
    .from("clips")
    .select("id, status, title, caption, hashtags")
    .in("id", clipIds);
  if (clipsError) {
    return NextResponse.json({ error: `Lettura clip fallita: ${clipsError.message}` }, { status: 500 });
  }
  const clipById = new Map((clips ?? []).map((c) => [c.id, c]));

  const { data: existingJobs, error: existingJobsError } = await supabase
    .from("youtube_publish_jobs")
    .select("clip_id, status, publish_at")
    .in("clip_id", clipIds)
    .neq("status", "FAILED");
  if (existingJobsError) {
    return NextResponse.json({ error: `Lettura job esistenti fallita: ${existingJobsError.message}` }, { status: 500 });
  }
  const alreadyPublishingClipIds = new Set((existingJobs ?? []).map((j) => j.clip_id));

  // Tutti gli slot futuri già programmati dall'utente (su QUALSIASI clip, non solo queste, e
  // RLS limita comunque alla riga dell'utente): i nuovi devono evitarli mantenendo un minimo di
  // spaziatura, ma senza saltare oltre finestre libere più vicine ad ora (vedi pickNextSlot).
  const { data: futureJobs } = await supabase
    .from("youtube_publish_jobs")
    .select("publish_at")
    .not("publish_at", "is", null)
    .gt("publish_at", new Date().toISOString())
    .order("publish_at", { ascending: true });

  const existingSorted = (futureJobs ?? [])
    .map((j) => new Date(j.publish_at!).getTime())
    .sort((a, b) => a - b);

  let cursor = Date.now();

  const scheduled: Array<{ clipId: string; publishAt: string }> = [];
  const errors: Array<{ clipId: string; error: string }> = [];

  for (const clipId of clipIds) {
    const clip = clipById.get(clipId);
    if (!clip) {
      errors.push({ clipId, error: "Clip non trovata" });
      continue;
    }
    if (clip.status !== "COMPLETED") {
      errors.push({ clipId, error: "La clip deve essere renderizzata prima di poter essere programmata" });
      continue;
    }
    if (alreadyPublishingClipIds.has(clipId)) {
      errors.push({ clipId, error: "Questa clip ha già una pubblicazione in corso o programmata" });
      continue;
    }

    cursor = pickNextSlot(cursor, existingSorted);
    const publishAt = new Date(cursor).toISOString();

    const { error: insertError } = await supabase.from("youtube_publish_jobs").insert({
      clip_id: clipId,
      title: clip.title.slice(0, 100),
      description: clip.caption ?? "",
      tags: (clip.hashtags as string[] | null) ?? [],
      privacy_status: "private",
      publish_at: publishAt,
    });
    if (insertError) {
      errors.push({ clipId, error: insertError.message });
      continue;
    }

    scheduled.push({ clipId, publishAt });
  }

  return NextResponse.json({ scheduled, errors });
}
