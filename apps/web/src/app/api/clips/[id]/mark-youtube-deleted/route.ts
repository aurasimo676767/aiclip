import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getValidYoutubeAccessToken } from "@/lib/youtube-scan";

/**
 * A differenza di cancel-schedule (che annulla una programmazione ancora futura), questa route
 * serve per il caso in cui l'utente ha GIÀ eliminato il video a mano da YouTube Studio (per
 * qualsiasi job, anche uno già pubblicato da tempo) — il sito non riceve nessun webhook per
 * queste cancellazioni dirette, quindi la riga resterebbe "fantasma" per sempre, bloccando sia
 * il riutilizzo della clip sia gli slot di programmazione futura che in realtà sono liberi (vedi
 * lo stesso self-heal automatico in schedule-batch). Qui l'azione è esplicita e manuale.
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
    .select("id, status, youtube_video_id, cancelled_at")
    .eq("clip_id", params.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (jobError || !job) {
    return NextResponse.json({ error: "Nessuna pubblicazione trovata per questa clip" }, { status: 404 });
  }
  if (job.cancelled_at) {
    return NextResponse.json({ error: "Questa pubblicazione è già segnata come eliminata" }, { status: 409 });
  }

  // Nessun controllo sullo status: l'utente qui sta dichiarando lo stato REALE su YouTube (che
  // il sito non può verificare da solo), quindi vale anche per job rimasti bloccati su
  // PENDING/UPLOADING (es. worker interrotto a metà upload — il video potrebbe comunque essere
  // stato creato su YouTube prima del crash, anche se qui non abbiamo mai salvato il suo id) o
  // finiti FAILED prima ancora di caricare nulla.
  const { data: connection } = await supabase.from("youtube_connections").select("*").eq("user_id", user.id).maybeSingle();
  if (connection && job.youtube_video_id) {
    try {
      const accessToken = await getValidYoutubeAccessToken(supabase, connection);
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(job.youtube_video_id)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
      );
      // 404 = confermato, il video non c'è più (il caso comune: l'utente l'ha già eliminato a
      // mano). Se invece esiste ancora, tentiamo comunque di eliminarlo qui: l'azione dell'utente
      // dichiara esplicitamente "l'ho tolto da YouTube", quindi lo togliamo per davvero anche se
      // per qualche motivo era ancora lì.
      if (!res.ok && res.status !== 404) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.error?.message ?? `YouTube ha rifiutato la richiesta (HTTP ${res.status})`);
      }
    } catch {
      // Non blocchiamo l'operazione se la chiamata a YouTube fallisce (token scaduto, rete, o
      // account nel frattempo scollegato): l'utente ha già confermato che il video non esiste
      // più, quindi allineiamo comunque il nostro DB.
    }
  }

  // Se il job è ancora PENDING/UPLOADING, claim_next_publish_job lo riprenderebbe in automatico
  // dopo lo stale-timeout ignorando cancelled_at (quel controllo guarda solo lo status) — quindi
  // lo portiamo a un stato terminale (FAILED) qui, altrimenti il worker ricaricherebbe la clip.
  const isTerminal = job.status === "COMPLETED" || job.status === "FAILED";
  const { error: updateError } = await supabase
    .from("youtube_publish_jobs")
    .update({
      cancelled_at: new Date().toISOString(),
      publish_at: null,
      youtube_video_id: null,
      youtube_url: null,
      ...(isTerminal
        ? {}
        : {
            status: "FAILED" as const,
            error_message: "Annullato manualmente dall'utente (video gestito/eliminato a mano su YouTube)",
            completed_at: new Date().toISOString(),
          }),
    })
    .eq("id", job.id);
  if (updateError) {
    return NextResponse.json({ error: `Aggiornamento fallito: ${updateError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
