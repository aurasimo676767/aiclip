import type { createSupabaseServerClient } from "@/lib/supabase/server";
import { zernioKey } from "@/lib/zernio";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/**
 * Uno Short pubblicato su YouTube esce anche su TikTok, con lo stesso orario: un tasto solo
 * (simo, 2026-09-29: "non devo fare due volte pubblica... SEMPRE pubblico e sempre con la
 * possibilità che possono commentare"). Pubblico, interazioni permesse (il worker spegne solo
 * quelle che TikTok ha disattivato sull'account). Niente doppioni: se la clip è già stata mandata
 * su TikTok non si rimanda. Un errore qui non blocca mai la pubblicazione su YouTube.
 */
export async function queueTiktokAlongside(
  supabase: SupabaseServerClient,
  userId: string,
  clip: { id: string; format: string; title: string; hashtags: unknown },
  publishAt: string | null,
): Promise<boolean> {
  if (clip.format !== "short") return false;
  try {
    if (!zernioKey()) {
      const { data: conn } = await supabase.from("tiktok_connections").select("id").eq("user_id", userId).maybeSingle();
      if (!conn) return false;
    }
    const { data: existing } = await supabase.from("tiktok_publish_jobs").select("id").eq("clip_id", clip.id).neq("status", "FAILED").limit(1);
    if (existing && existing.length > 0) return false;
    const tags = ((clip.hashtags as string[] | null) ?? []).map((h) => (h.startsWith("#") ? h : `#${h}`));
    const { error } = await supabase.from("tiktok_publish_jobs").insert({
      clip_id: clip.id,
      user_id: userId,
      caption: [clip.title, ...tags].join(" ").slice(0, 2200),
      privacy_level: "PUBLIC_TO_EVERYONE",
      disable_comment: false,
      disable_duet: false,
      disable_stitch: false,
      publish_at: publishAt,
    });
    return !error;
  } catch {
    return false;
  }
}
