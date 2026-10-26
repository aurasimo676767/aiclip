import { NextResponse } from "next/server";
import { z } from "zod";
import { captionSettingsSchema } from "@clipforge/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({ name: z.string().trim().min(1).max(40), settings: captionSettingsSchema });

/** Preset personali dei sottotitoli: elenco. */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  const { data, error } = await supabase.from("caption_presets").select("id, name, settings, created_at").order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ presets: data ?? [] });
}

/** Salva uno stile come preset con un nome. */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Nome o stile non validi" }, { status: 400 });
  const { data, error } = await supabase
    .from("caption_presets")
    .insert({ user_id: user.id, name: parsed.data.name, settings: parsed.data.settings })
    .select("id, name, settings")
    .single();
  if (error) return NextResponse.json({ error: `Preset non salvato: ${error.message}` }, { status: 500 });
  return NextResponse.json({ preset: data });
}
