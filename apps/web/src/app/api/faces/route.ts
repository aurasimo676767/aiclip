import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readFaceIndex, writeFaceIndex } from "@/lib/face-library";

const bodySchema = z.object({
  id: z.string().uuid(),
  /** Nome da dare (maiuscolo), null per toglierlo e rimettere la faccia fra quelle da nominare. */
  label: z.string().trim().min(1).max(40).nullable().optional(),
  /** true = scarta la faccia (non verrà mai usata). */
  reject: z.boolean().optional(),
});

/** Dà un nome a una faccia della libreria delle copertine, o la scarta. */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  const { id, label, reject } = parsed.data;

  const index = await readFaceIndex(user.id);
  const face = index.faces.find((f) => f.id === id);
  if (!face) return NextResponse.json({ error: "Faccia non trovata" }, { status: 404 });

  if (reject) {
    face.status = "rejected";
    face.label = null;
  } else if (label !== undefined) {
    face.label = label ? label.toUpperCase() : null;
    face.status = label ? "labeled" : "candidate";
  }
  await writeFaceIndex(user.id, index);
  return NextResponse.json({ ok: true, face });
}

/** Persone con almeno una faccia col nome in libreria: sono quelle che si possono mettere in copertina. */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  const index = await readFaceIndex(user.id).catch(() => ({ faces: [] as Array<{ status: string; label: string | null }> }));
  const people = [...new Set(index.faces.filter((f) => f.status === "labeled" && f.label).map((f) => f.label!))].sort();
  return NextResponse.json({ people });
}
