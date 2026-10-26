import { NextResponse } from "next/server";
import { z } from "zod";
import { captionSettingsSchema } from "@clipforge/shared";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({ name: z.string().trim().min(1).max(40).optional(), settings: captionSettingsSchema.optional() });

/** Rinomina un preset o ne aggiorna lo stile. La RLS limita ai preset dell'utente. */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || (!parsed.data.name && !parsed.data.settings)) return NextResponse.json({ error: "Niente da salvare" }, { status: 400 });
  const { error } = await supabase
    .from("caption_presets")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  const { error } = await supabase.from("caption_presets").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
