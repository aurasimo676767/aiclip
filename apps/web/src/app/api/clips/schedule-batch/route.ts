import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getValidYoutubeAccessToken, filterExistingYoutubeVideoIds } from "@/lib/youtube-scan";
import { pickNextFixedSlots } from "@/lib/publish-schedule";

const MIN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h
const MAX_INTERVAL_MS = 2.5 * 60 * 60 * 1000; // 2h30
const MAX_CLIPS_PER_BATCH = 20;

const bodySchema = z.object({ clipIds: z.array(z.string().uuid()).min(1).max(MAX_CLIPS_PER_BATCH) });

function randomIntervalMs(): number {
  return MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
}

/**
 * FALLBACK per chi non ha ancora configurato orari fissi (vedi Impostazioni → Programmazione):
 * trova il prossimo slot valido da `cursor` in poi, rispettando un minimo di MIN_INTERVAL_MS da
 * qualunque slot GIÀ programmato (`existingSorted`, ordinato crescente, solo slot futuri). Se il
 * candidato cade troppo vicino a uno slot esistente, non lo scarta e basta: usa quello slot
 * esistente come nuovo `cursor` e riprova — così i nuovi slot riempiono per prime le finestre
 * LIBERE più vicine ad ora, invece di accodarsi sempre dopo l'ultimo slot esistente.
 */
function pickNextRandomSlot(cursor: number, existingSorted: number[]): number {
  const candidate = cursor + randomIntervalMs();
  for (const existing of existingSorted) {
    if (existing < cursor) continue; // già superato, non è più un vincolo
    if (Math.abs(candidate - existing) < MIN_INTERVAL_MS) {
      return pickNextRandomSlot(existing, existingSorted);
    }
    if (existing > candidate) break; // ordinati: i successivi sono ancora più lontani, nessun altro conflitto possibile
  }
  return candidate;
}

/**
 * Programma automaticamente più clip su YouTube. Se l'utente ha configurato orari fissi per il
 * formato di una clip (Impostazioni → Programmazione, vedi publish_schedules), usa quelli — Shorts
 * e long-form hanno griglie indipendenti. Altrimenti ricade sul vecchio comportamento (2h-2h30
 * random da adesso, uguale per tutti i formati), per chi non ha ancora configurato nulla.
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

  const { data: connection } = await supabase.from("youtube_connections").select("*").eq("user_id", user.id).maybeSingle();
  if (!connection) {
    return NextResponse.json({ error: "Collega prima un account YouTube dalle Impostazioni" }, { status: 409 });
  }

  const { data: clips, error: clipsError } = await supabase
    .from("clips")
    .select("id, status, title, caption, hashtags, format")
    .in("id", clipIds);
  if (clipsError) {
    return NextResponse.json({ error: `Lettura clip fallita: ${clipsError.message}` }, { status: 500 });
  }
  const clipById = new Map((clips ?? []).map((c) => [c.id, c]));

  const { data: scheduleSettings } = await supabase
    .from("publish_schedules")
    .select("short_times, longform_times")
    .eq("user_id", user.id)
    .maybeSingle();
  const timesByFormat: Record<"short" | "longform", string[]> = {
    short: scheduleSettings?.short_times ?? [],
    longform: scheduleSettings?.longform_times ?? [],
  };

  // Un job annullato (cancelled_at valorizzato) NON conta come "già in pubblicazione": il video
  // è stato eliminato da YouTube e la clip è di nuovo libera per una nuova programmazione.
  const { data: existingJobs, error: existingJobsError } = await supabase
    .from("youtube_publish_jobs")
    .select("id, clip_id, status, publish_at, youtube_video_id")
    .in("clip_id", clipIds)
    .neq("status", "FAILED")
    .is("cancelled_at", null);
  if (existingJobsError) {
    return NextResponse.json({ error: `Lettura job esistenti fallita: ${existingJobsError.message}` }, { status: 500 });
  }

  // Tutti gli slot futuri già programmati dall'utente (su QUALSIASI clip, non solo queste, e
  // RLS limita comunque alla riga dell'utente): i nuovi devono evitarli. clip_id serve per sapere
  // il formato di ogni slot già occupato (le griglie orarie di Shorts e long-form sono separate).
  const { data: futureJobs } = await supabase
    .from("youtube_publish_jobs")
    .select("id, clip_id, publish_at, youtube_video_id")
    .not("publish_at", "is", null)
    .gt("publish_at", new Date().toISOString())
    .order("publish_at", { ascending: true });

  const futureJobClipIds = [...new Set((futureJobs ?? []).map((j) => j.clip_id))];
  const { data: futureJobClips } = await supabase.from("clips").select("id, format").in("id", futureJobClipIds);
  const formatByClipId = new Map((futureJobClips ?? []).map((c) => [c.id, c.format]));

  // Il sito non riceve nessun webhook da YouTube: se l'utente ha eliminato dei video a mano da
  // YouTube Studio, questi job restano "fantasma" in DB e bloccherebbero per errore sia il
  // riutilizzo della clip sia gli slot che in realtà sono di nuovo liberi. Verifichiamo quindi
  // quali video esistono ancora prima di usarli come vincoli, e "guariamo" gli altri.
  const candidateVideoIds = [
    ...(existingJobs ?? []).map((j) => j.youtube_video_id),
    ...(futureJobs ?? []).map((j) => j.youtube_video_id),
  ].filter((id): id is string => Boolean(id));

  let stillExistingVideoIds = new Set<string>(candidateVideoIds);
  if (candidateVideoIds.length > 0) {
    try {
      const accessToken = await getValidYoutubeAccessToken(supabase, connection);
      stillExistingVideoIds = await filterExistingYoutubeVideoIds([...new Set(candidateVideoIds)], accessToken);
    } catch {
      // Se la verifica su YouTube fallisce (token, rete, quota), non blocchiamo la programmazione:
      // si ragiona sui dati DB così come sono, nel peggiore dei casi un job fantasma resta un vincolo.
    }
  }

  const ghostJobIds = [
    ...(existingJobs ?? []),
    ...(futureJobs ?? []),
  ]
    .filter((j) => j.youtube_video_id && !stillExistingVideoIds.has(j.youtube_video_id))
    .map((j) => j.id);
  if (ghostJobIds.length > 0) {
    await supabase
      .from("youtube_publish_jobs")
      .update({ cancelled_at: new Date().toISOString(), publish_at: null, youtube_video_id: null, youtube_url: null })
      .in("id", [...new Set(ghostJobIds)]);
  }
  const ghostJobIdSet = new Set(ghostJobIds);

  const alreadyPublishingClipIds = new Set(
    (existingJobs ?? []).filter((j) => !ghostJobIdSet.has(j.id)).map((j) => j.clip_id),
  );

  const validFutureJobs = (futureJobs ?? []).filter((j) => !ghostJobIdSet.has(j.id));
  const existingSlotsByFormat: Record<"short" | "longform", Date[]> = { short: [], longform: [] };
  for (const j of validFutureJobs) {
    const format = formatByClipId.get(j.clip_id);
    if (format === "short" || format === "longform") {
      existingSlotsByFormat[format].push(new Date(j.publish_at!));
    }
  }
  const existingSortedMsByFormat: Record<"short" | "longform", number[]> = {
    short: existingSlotsByFormat.short.map((d) => d.getTime()).sort((a, b) => a - b),
    longform: existingSlotsByFormat.longform.map((d) => d.getTime()).sort((a, b) => a - b),
  };

  const scheduled: Array<{ clipId: string; publishAt: string }> = [];
  const errors: Array<{ clipId: string; error: string }> = [];

  // Pass 1: valida e raggruppa per formato, mantenendo l'ordine originale dentro ogni gruppo.
  const validClipIdsByFormat: Record<"short" | "longform", string[]> = { short: [], longform: [] };
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
    validClipIdsByFormat[clip.format].push(clipId);
  }

  // Pass 2: calcola gli slot per formato — griglia fissa se configurata (Impostazioni →
  // Programmazione), altrimenti il vecchio comportamento 2h-2h30 random come fallback.
  const publishAtByClipId = new Map<string, Date>();
  for (const format of ["short", "longform"] as const) {
    const ids = validClipIdsByFormat[format];
    if (ids.length === 0) continue;

    const configuredTimes = timesByFormat[format];
    if (configuredTimes.length > 0) {
      const slots = pickNextFixedSlots({
        times: configuredTimes,
        count: ids.length,
        existingFutureSlots: existingSlotsByFormat[format],
      });
      ids.forEach((clipId, i) => publishAtByClipId.set(clipId, slots[i]!));
    } else {
      let cursor = Date.now();
      for (const clipId of ids) {
        cursor = pickNextRandomSlot(cursor, existingSortedMsByFormat[format]);
        publishAtByClipId.set(clipId, new Date(cursor));
      }
    }
  }

  // Pass 3: inserimento, nell'ordine originale della richiesta.
  for (const clipId of clipIds) {
    const publishAtDate = publishAtByClipId.get(clipId);
    if (!publishAtDate) continue; // già in errors (pass 1)

    const clip = clipById.get(clipId)!;
    const publishAt = publishAtDate.toISOString();

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
