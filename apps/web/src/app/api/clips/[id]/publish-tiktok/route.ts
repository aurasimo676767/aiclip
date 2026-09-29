import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { zernioKey } from "@/lib/zernio";

const bodySchema = z.object({
  caption: z.string().max(2200),
  privacyLevel: z.string().min(1),
  allowComment: z.boolean(),
  allowDuet: z.boolean(),
  allowStitch: z.boolean(),
  brandOrganic: z.boolean(),
  brandContent: z.boolean(),
});

/**
 * Mette in coda la pubblicazione di una clip su TikTok con le scelte fatte nella finestra
 * "Pubblica su TikTok". Il caricamento vero lo fa il worker (process-tiktok-publish-job.ts).
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi" }, { status: 400 });
  const b = parsed.data;
  // Regola TikTok: i contenuti sponsorizzati non possono essere privati.
  if (b.brandContent && b.privacyLevel === "SELF_ONLY") {
    return NextResponse.json({ error: "Un contenuto sponsorizzato non può essere visibile solo a te" }, { status: 400 });
  }

  const { data: clip } = await supabase.from("clips").select("id, status").eq("id", params.id).maybeSingle();
  if (!clip) return NextResponse.json({ error: "Clip non trovata" }, { status: 404 });
  if (clip.status !== "COMPLETED") return NextResponse.json({ error: "La clip non è ancora pronta" }, { status: 409 });

  const { data: conn } = await supabase.from("tiktok_connections").select("id").eq("user_id", user.id).maybeSingle();
  // Con Zernio l'account TikTok è collegato da loro, non serve il nostro collegamento.
  if (!conn && !zernioKey()) return NextResponse.json({ error: "Collega prima TikTok dalle Opzioni" }, { status: 409 });

  const { error } = await supabase.from("tiktok_publish_jobs").insert({
    clip_id: clip.id,
    user_id: user.id,
    caption: b.caption,
    privacy_level: b.privacyLevel,
    disable_comment: !b.allowComment,
    disable_duet: !b.allowDuet,
    disable_stitch: !b.allowStitch,
    brand_organic_toggle: b.brandOrganic,
    brand_content_toggle: b.brandContent,
  });
  if (error) return NextResponse.json({ error: `Messa in coda fallita: ${error.message}` }, { status: 500 });
  return NextResponse.json({ ok: true });
}
