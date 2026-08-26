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
 * Programma automaticamente più clip in fila su YouTube, distanziate 2h-2h30 l'una dall'altra
 * (variabile per non essere un pattern troppo riconoscibile) — "capisce" che è già presente
 * uno slot programmato guardando il publish_at più lontano nel futuro tra i job esistenti
 * dell'utente e accoda i nuovi dopo quello, invece di rischiare sovrapposizioni.
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

  // Ultimo slot già programmato dall'utente (su QUALSIASI clip, non solo queste): i nuovi
  // vanno messi in coda dopo quello, non solo dopo "adesso".
  const { data: latestScheduled } = await supabase
    .from("youtube_publish_jobs")
    .select("publish_at")
    .not("publish_at", "is", null)
    .order("publish_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let cursor = Math.max(Date.now(), latestScheduled?.publish_at ? new Date(latestScheduled.publish_at).getTime() : 0);

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

    cursor += randomIntervalMs();
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
