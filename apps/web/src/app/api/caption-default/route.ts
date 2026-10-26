import { NextResponse } from "next/server";
import { z } from "zod";
import { captionSettingsSchema } from "@clipforge/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({ settings: captionSettingsSchema.nullable() });

/** Stile di partenza dei nuovi Shorts (null = Classico). */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Stile non valido" }, { status: 400 });
  const { error } = await supabase.from("profiles").update({ default_caption_settings: parsed.data.settings }).eq("id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
