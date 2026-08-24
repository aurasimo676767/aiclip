import { NextResponse } from "next/server";
import { z } from "zod";
import type { EditDecisionList } from "@clipforge/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const MIN_DURATION_SECONDS = 3;

const bodySchema = z
  .object({
    // Secondi relativi alla timeline della clip ATTUALE (0 = inizio clip corrente).
    newStartOffset: z.number().min(0),
    newEndOffset: z.number().positive(),
  })
  .refine((v) => v.newEndOffset - v.newStartOffset >= MIN_DURATION_SECONDS, `La clip deve restare lunga almeno ${MIN_DURATION_SECONDS}s`);

/**
 * Accorcia una clip già renderizzata (taglio inizio/fine, non tagli interni) e la rimanda in
 * coda per il render: aggiorna start_time/end_time sul video SORGENTE e filtra gli eventi EDL
 * fuori dal nuovo intervallo, poi riusa la pipeline di render esistente (transcript/captions/
 * crop vengono ricostruiti da zero a partire dai nuovi start/end, nessuna logica nuova lato worker).
 */
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
  const { newStartOffset, newEndOffset } = parsed.data;

  const { data: clip, error: clipError } = await supabase
    .from("clips")
    .select("id, status, start_time, end_time, duration, edl")
    .eq("id", params.id)
    .single();
  if (clipError || !clip) {
    return NextResponse.json({ error: "Clip non trovata" }, { status: 404 });
  }
  if (clip.status !== "COMPLETED") {
    return NextResponse.json({ error: "Puoi modificare solo una clip già renderizzata" }, { status: 409 });
  }
  if (newEndOffset > clip.duration) {
    return NextResponse.json({ error: "Il nuovo punto di fine supera la durata attuale della clip" }, { status: 400 });
  }

  const newStartTime = clip.start_time + newStartOffset;
  const newEndTime = clip.start_time + newEndOffset;
  const newDuration = newEndTime - newStartTime;

  const edl = clip.edl as EditDecisionList;
  const filteredEdl: EditDecisionList = {
    ...edl,
    events: (edl.events ?? []).filter((e) => e.time >= newStartTime && e.time <= newEndTime),
  };

  const { error: updateError } = await supabase
    .from("clips")
    .update({
      start_time: newStartTime,
      end_time: newEndTime,
      duration: newDuration,
      edl: filteredEdl,
      status: "QUEUED",
      output_video_path: null,
      thumbnail_path: null,
      error_message: null,
    })
    .eq("id", clip.id);
  if (updateError) {
    return NextResponse.json({ error: `Aggiornamento clip fallito: ${updateError.message}` }, { status: 500 });
  }

  const { error: renderError } = await supabase.from("render_jobs").insert({ clip_id: clip.id });
  if (renderError) {
    return NextResponse.json({ error: `Creazione render job fallita: ${renderError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, duration: newDuration });
}
