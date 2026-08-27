import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getValidYoutubeAccessToken } from "@/lib/youtube-scan";

/**
 * Annulla una pubblicazione YouTube GIÀ CARICATA (privata, in attesa che YouTube la renda
 * pubblica da sola a publish_at): il file è già su YouTube, quindi "annullare" significa
 * togliere la programmazione nativa di YouTube (status.privacyStatus="private" senza
 * publishAt annulla lo scheduled publish) — NON elimina il video, resta privato e riusabile
 * a mano da YouTube Studio se serve.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const { data: job, error: jobError } = await supabase
    .from("youtube_publish_jobs")
    .select("id, status, youtube_video_id, publish_at, cancelled_at")
    .eq("clip_id", params.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (jobError || !job) {
    return NextResponse.json({ error: "Nessuna pubblicazione trovata per questa clip" }, { status: 404 });
  }
  if (job.cancelled_at) {
    return NextResponse.json({ error: "La programmazione è già stata annullata" }, { status: 409 });
  }
  if (job.status !== "COMPLETED" || !job.youtube_video_id) {
    return NextResponse.json({ error: "Il video non risulta ancora caricato su YouTube" }, { status: 409 });
  }
  if (!job.publish_at || new Date(job.publish_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: "Il video è già pubblico, non è più possibile annullare" }, { status: 409 });
  }

  const { data: connection } = await supabase.from("youtube_connections").select("*").eq("user_id", user.id).maybeSingle();
  if (!connection) {
    return NextResponse.json({ error: "Nessun account YouTube collegato" }, { status: 409 });
  }

  try {
    const accessToken = await getValidYoutubeAccessToken(supabase, connection);

    const res = await fetch("https://www.googleapis.com/youtube/v3/videos?part=status", {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: job.youtube_video_id, status: { privacyStatus: "private" } }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.error?.message ?? `YouTube ha rifiutato la richiesta (HTTP ${res.status})`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Annullamento su YouTube fallito: ${message}` }, { status: 500 });
  }

  const { error: updateError } = await supabase
    .from("youtube_publish_jobs")
    .update({ cancelled_at: new Date().toISOString(), publish_at: null })
    .eq("id", job.id);
  if (updateError) {
    return NextResponse.json({ error: `Aggiornamento fallito: ${updateError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
