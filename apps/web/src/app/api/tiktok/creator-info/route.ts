import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { tiktokAccessToken, tiktokCreatorInfo } from "@/lib/tiktok";
import { zernioCreatorInfo, zernioKey } from "@/lib/zernio";

/**
 * Chi pubblica e con quali opzioni (privacy possibili, commenti/duetti/stitch disattivati
 * dall'utente, durata massima): la finestra "Pubblica su TikTok" lo chiede ogni volta che si apre,
 * come vogliono le regole della Content Posting API.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  try {
    // Con Zernio (app TikTok già approvata) l'account è quello collegato su zernio.com.
    const zk = zernioKey();
    if (zk) return NextResponse.json(await zernioCreatorInfo(zk));
    const token = await tiktokAccessToken(supabase, user.id);
    if (!token) return NextResponse.json({ error: "Collega prima TikTok dalle Opzioni" }, { status: 409 });
    return NextResponse.json(await tiktokCreatorInfo(token));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
