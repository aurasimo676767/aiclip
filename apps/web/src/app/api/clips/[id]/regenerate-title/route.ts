import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { buildLongformTitleStylePrompt } from "@clipforge/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const TOOL_NAME = "return_regenerated_title";

// Compito semplice (riformattare un titolo esistente secondo una convenzione fissa, non
// analizzare ore di transcript) — Haiku basta e costa una frazione di un centesimo a chiamata,
// niente bisogno del modello forte usato per il ranking iniziale.
const MODEL = "claude-haiku-4-5-20251001";

/**
 * Rigenera SOLO il titolo di una clip long-form già renderizzata, con la convenzione di titoli
 * più recente (alias/REACTION/GIOCA A/GIOCANO A) — utile per le clip create prima che questa
 * convenzione esistesse, senza dover ri-renderizzare o ripassare da tutta la pipeline IA. Usa
 * hook/reason/caption già salvati sulla clip come contesto, non il transcript completo: più
 * veloce, più economico, e sufficiente perché quei campi già riassumono cosa succede nel segmento.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const { data: clip, error: clipError } = await supabase
    .from("clips")
    .select("id, video_id, format, title, hook, reason, caption")
    .eq("id", params.id)
    .maybeSingle();
  if (clipError || !clip) {
    return NextResponse.json({ error: "Clip non trovata" }, { status: 404 });
  }
  if (clip.format !== "longform") {
    return NextResponse.json({ error: "La rigenerazione titolo è disponibile solo per i video long-form" }, { status: 400 });
  }

  const { data: video } = await supabase.from("videos").select("original_filename, streamer_name").eq("id", clip.video_id).single();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY non configurata sul sito" }, { status: 500 });
  }

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: `Sei un editor che rigenera SOLO il titolo di pubblicazione YouTube di un video long-form già montato, applicando la convenzione più recente. Ti vengono dati il vecchio titolo e un riassunto di cosa succede nel segmento (non il transcript completo): usali per capire il contesto e produrre il nuovo titolo. Rispondi chiamando lo strumento ${TOOL_NAME}.\n\n${buildLongformTitleStylePrompt()}`,
    messages: [
      {
        role: "user",
        content: `Video: "${video?.original_filename ?? "sconosciuto"}"${video?.streamer_name ? ` — streamer: ${video.streamer_name}` : ""}
Titolo attuale (da sostituire, probabilmente con lo stile vecchio): "${clip.title}"
Riassunto del segmento (hook): ${clip.hook}
Perché regge da solo: ${clip.reason}
Descrizione pubblica già scritta: ${clip.caption}`,
      },
    ],
    tools: [
      {
        name: TOOL_NAME,
        description: "Restituisce il nuovo titolo rigenerato.",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Il nuovo titolo, max ~100 caratteri." },
          },
          required: ["title"],
        },
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
  });

  const toolUseBlock = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME,
  );
  const newTitle = toolUseBlock && typeof toolUseBlock.input === "object" && toolUseBlock.input && "title" in toolUseBlock.input
    ? String((toolUseBlock.input as { title: unknown }).title).slice(0, 100)
    : null;

  if (!newTitle) {
    return NextResponse.json({ error: "L'IA non ha restituito un titolo valido" }, { status: 502 });
  }

  const { error: updateError } = await supabase.from("clips").update({ title: newTitle }).eq("id", clip.id);
  if (updateError) {
    return NextResponse.json({ error: `Aggiornamento titolo fallito: ${updateError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, title: newTitle });
}
