import type { TiktokPublishJobRow } from "@clipforge/db";
import { logger } from "../lib/logger.js";

/**
 * Pubblicazione su TikTok tramite Zernio (zernio.com), che ha già l'app TikTok approvata: la usiamo
 * finché TikTok non approva la nostra (simo, 2026-09-29). Zernio scarica il video da un link
 * pubblico (il link firmato di R2 va bene) e lo pubblica sull'account TikTok collegato da simo.
 */

const ZERNIO_API = "https://zernio.com/api/v1";

type Json = Record<string, unknown>;

function asList(v: unknown): Json[] {
  if (Array.isArray(v)) return v as Json[];
  if (v && typeof v === "object") {
    for (const k of ["accounts", "data", "items", "results"]) {
      const inner = (v as Json)[k];
      if (Array.isArray(inner)) return inner as Json[];
    }
  }
  return [];
}

async function zernio<T>(key: string, path: string, init?: { method: string; body: unknown }): Promise<T> {
  const res = await fetch(`${ZERNIO_API}${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zernio ${path}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function publishTiktokViaZernio(
  key: string,
  job: TiktokPublishJobRow,
  videoUrl: string,
  coverUrl: string | null,
): Promise<{ postId: string | null; url: string | null }> {
  const accounts = asList(await zernio<unknown>(key, "/accounts"));
  const acc = accounts.find((a) => String(a.platform ?? "").toLowerCase() === "tiktok");
  const accountId = acc ? String(acc._id ?? acc.id ?? acc.accountId ?? "") : "";
  if (!accountId) throw new Error("Nessun account TikTok collegato in Zernio: collegalo su zernio.com");

  const tiktokSettings = {
    privacy_level: job.privacy_level,
    allow_comment: !job.disable_comment,
    allow_duet: !job.disable_duet,
    allow_stitch: !job.disable_stitch,
    // Obbligatori per TikTok: simo ha visto l'anteprima e ha premuto Pubblica nella finestra del sito.
    content_preview_confirmed: true,
    express_consent_given: true,
    // Nomi dei campi del contenuto commerciale secondo creator-info di Zernio (commercialContentTypes).
    is_brand_organic_post: job.brand_organic_toggle,
    brand_partner_promote: job.brand_content_toggle,
    // Copertina scelta sul sito (simo, 2026-09-29: "non c'è la copertina"); senza, un fotogramma.
    ...(coverUrl ? { video_cover_image_url: coverUrl } : { video_cover_timestamp_ms: 1000 }),
  };
  const res = await zernio<Json>(key, "/posts", {
    method: "POST",
    body: {
      content: job.caption,
      mediaItems: [{ type: "video", url: videoUrl }],
      platforms: [{ platform: "tiktok", accountId, platformSpecificData: { tiktokSettings } }],
      tiktokSettings,
      // Programmato: pubblica Zernio all'orario scelto (anche a PC spento). Altrimenti subito.
      ...(job.publish_at && new Date(job.publish_at).getTime() > Date.now() ? { scheduledFor: job.publish_at, timezone: "Europe/Rome" } : { publishNow: true }),
    },
  });
  const post = ((res.post as Json) ?? (res.data as Json) ?? res) as Json;
  const status = String(post.status ?? "").toLowerCase();
  logger.info("Zernio: risposta alla pubblicazione", { jobId: job.id, risposta: JSON.stringify(res).slice(0, 600) });
  if (status === "failed" || status === "error") {
    throw new Error(`Zernio ha rifiutato il video: ${String(post.error ?? post.errorMessage ?? post.message ?? "motivo non indicato")}`);
  }
  const postId = String(post._id ?? post.id ?? "") || null;
  // Programmato: pubblica Zernio all'orario, qui non c'è altro da aspettare.
  if (!postId || (job.publish_at && new Date(job.publish_at).getTime() > Date.now())) {
    return { postId, url: (post.platformPostUrl as string | undefined) ?? null };
  }
  // Subito: Zernio risponde "publishing" e carica su TikTok dopo. Si aspetta l'esito vero, così il
  // sito non dice "pubblicato" per un video che TikTok poi rifiuta.
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    const cur = await zernio<Json>(key, `/posts/${postId}`);
    const p = ((cur.post as Json) ?? cur) as Json;
    const tt = (Array.isArray(p.platforms) ? (p.platforms as Json[]) : []).find((x) => String(x.platform ?? "").toLowerCase() === "tiktok") ?? {};
    const st = String(tt.status ?? p.status ?? "").toLowerCase();
    if (st === "published") return { postId, url: (tt.platformPostUrl as string | undefined) ?? null };
    if (st === "failed" || st === "error") {
      throw new Error(`TikTok ha rifiutato il video: ${String(tt.errorMessage ?? tt.error ?? p.errorMessage ?? "motivo non indicato")}`);
    }
  }
  throw new Error("Zernio non ha confermato la pubblicazione in 10 minuti: controlla il profilo TikTok");
}
