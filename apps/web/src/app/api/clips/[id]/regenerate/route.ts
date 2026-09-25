import { NextResponse } from "next/server";
import { TEMPLATE_NAMES, type EditDecisionList, type EditingStyle, type TemplateName } from "@clipforge/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const EDITING_STYLE: Record<TemplateName, EditingStyle> = {
  PODCAST_DYNAMIC: "dynamic",
  PODCAST_CLEAN: "clean",
  STREAMER: "high_energy",
  STORYTELLING: "calm",
  MOTIVATIONAL: "high_energy",
};

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });

  // La RLS limita lettura e aggiornamento alle clip dell'utente.
  const { data: clip, error: clipError } = await supabase
    .from("clips")
    .select("id, status, format, template, editing_style, edl, error_message")
    .eq("id", params.id)
    .single();
  if (clipError || !clip) return NextResponse.json({ error: "Clip non trovata" }, { status: 404 });
  if (clip.status !== "COMPLETED") {
    return NextResponse.json({ error: "Puoi rigenerare solo una clip già completata" }, { status: 409 });
  }

  // Short: cambia il preset usato dal renderer, lasciando invariato l'estratto. Long-form: il
  // template non conta (solo taglio o montaggio automatico, vedi clips.longform_edit), resta com'è.
  const currentTemplate = TEMPLATE_NAMES.includes(clip.template as TemplateName) ? clip.template as TemplateName : "PODCAST_CLEAN";
  const template =
    clip.format === "short" ? TEMPLATE_NAMES[(TEMPLATE_NAMES.indexOf(currentTemplate) + 1) % TEMPLATE_NAMES.length]! : currentTemplate;
  const { data: queued, error: updateError } = await supabase
    .from("clips")
    .update({
      status: "QUEUED",
      template,
      editing_style: EDITING_STYLE[template],
      edl: { ...(clip.edl as EditDecisionList), template },
      error_message: null,
    })
    .eq("id", clip.id)
    .eq("status", "COMPLETED")
    .select("id")
    .maybeSingle();
  if (updateError) return NextResponse.json({ error: "Aggiornamento clip fallito" }, { status: 500 });
  if (!queued) return NextResponse.json({ error: "La clip è già in lavorazione" }, { status: 409 });

  const { error: renderError } = await supabase.from("render_jobs").insert({ clip_id: clip.id });
  if (renderError) {
    // Conserva il render precedente e ripristina lo stile se la coda rifiuta il job.
    const { error: restoreError } = await supabase.from("clips").update({
      status: "COMPLETED",
      template: clip.template,
      editing_style: clip.editing_style,
      edl: clip.edl,
      error_message: clip.error_message,
    }).eq("id", clip.id).eq("status", "QUEUED");
    return NextResponse.json({ error: restoreError
      ? "Creazione render job e ripristino della clip falliti"
      : "Creazione render job fallita, la clip precedente è ancora disponibile",
    }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
