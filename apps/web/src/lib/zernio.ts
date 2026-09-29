import type { TiktokCreatorInfo } from "@/lib/tiktok";

/**
 * Zernio (zernio.com): servizio che ha già l'app TikTok approvata. Lo usiamo finché TikTok non approva
 * la nostra (simo, 2026-09-29: "un modo per automatizzare tiktok nel mentre"): simo collega il suo
 * account TikTok dentro Zernio e noi pubblichiamo con la loro API. Piano gratuito: 2 account.
 * Se ZERNIO_API_KEY c'è, il tasto "TikTok" passa da qui invece che dalla nostra app.
 */

const ZERNIO_API = "https://zernio.com/api/v1";

export function zernioKey(): string | null {
  return process.env.ZERNIO_API_KEY || null;
}

async function zernioGet<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${ZERNIO_API}${path}`, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zernio ${path}: ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

type Json = Record<string, unknown>;

/** Le risposte di Zernio possono avere la lista dentro "data", "accounts" o direttamente. */
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

const str = (o: Json, ...keys: string[]) => {
  for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  return "";
};

export interface ZernioTiktokAccount {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Il primo account TikTok collegato in Zernio, o null. */
export async function zernioTiktokAccount(key: string): Promise<ZernioTiktokAccount | null> {
  const list = asList(await zernioGet<unknown>("/accounts", key));
  const acc = list.find((a) => str(a, "platform").toLowerCase() === "tiktok");
  if (!acc) return null;
  return {
    id: str(acc, "_id", "id", "accountId"),
    username: str(acc, "username", "handle"),
    displayName: str(acc, "displayName", "display_name", "name", "username"),
    avatarUrl: str(acc, "profilePicture", "avatarUrl", "avatar_url", "profile_picture_url") || null,
  };
}

/** Stessa forma di creator_info di TikTok, per riusare la finestra "Pubblica su TikTok". */
export async function zernioCreatorInfo(key: string): Promise<TiktokCreatorInfo & { zernioAccountId: string }> {
  const acc = await zernioTiktokAccount(key);
  if (!acc) throw new Error("Nessun account TikTok collegato in Zernio: collegalo su zernio.com");
  const raw = await zernioGet<Json>(`/accounts/${acc.id}/tiktok/creator-info`, key);
  const info = ((raw.data as Json) ?? (raw.creatorInfo as Json) ?? raw) as Json;
  const options = info.privacy_level_options ?? info.privacyLevelOptions;
  return {
    zernioAccountId: acc.id,
    creator_avatar_url: str(info, "creator_avatar_url", "creatorAvatarUrl") || acc.avatarUrl || "",
    creator_username: str(info, "creator_username", "creatorUsername") || acc.username,
    creator_nickname: str(info, "creator_nickname", "creatorNickname") || acc.displayName,
    privacy_level_options: Array.isArray(options) && options.length > 0 ? (options as string[]) : ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
    comment_disabled: Boolean(info.comment_disabled ?? info.commentDisabled),
    duet_disabled: Boolean(info.duet_disabled ?? info.duetDisabled),
    stitch_disabled: Boolean(info.stitch_disabled ?? info.stitchDisabled),
    max_video_post_duration_sec: Number(info.max_video_post_duration_sec ?? info.maxVideoPostDurationSec ?? 600),
  };
}
