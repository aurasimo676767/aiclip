import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchAllVods } from "@/lib/twitch-scan";
import type { TwitchFeedVideo } from "@/app/api/channels/twitch-feed/route";

/**
 * Come /api/channels/twitch-feed ma per UN SOLO canale e senza il limite di 6 VOD — usato dalla
 * pagina "tutti i VOD di questo canale" (vedi dashboard/feed/twitch/[id]), per poter generare in
 * blocco l'intero storico ancora disponibile su Twitch (~2 mesi) invece di doverli scorrere uno
 * alla volta nel feed misto tra tutti i canali seguiti.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const { data: channel, error: channelError } = await supabase
    .from("followed_twitch_channels")
    .select("id, twitch_user_id, login, display_name")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (channelError || !channel) {
    return NextResponse.json({ error: "Canale non trovato" }, { status: 404 });
  }

  try {
    const { data: userProjects } = await supabase.from("projects").select("id").eq("user_id", user.id);
    const projectIds = (userProjects ?? []).map((p) => p.id);
    const { data: existingVideos } =
      projectIds.length > 0 ? await supabase.from("videos").select("source_url").in("project_id", projectIds) : { data: [] };
    const existingUrls = new Set((existingVideos ?? []).map((v) => v.source_url).filter(Boolean));

    const vods = await fetchAllVods(channel.twitch_user_id);

    const videos: TwitchFeedVideo[] = vods
      .map((v) => ({
        vodId: v.vodId,
        vodUrl: v.url,
        title: v.title,
        thumbnailUrl: v.thumbnailUrl,
        channelId: channel.id,
        streamerName: channel.display_name,
        streamerLogin: channel.login,
        createdAt: v.createdAt,
        durationSeconds: v.durationSeconds,
        alreadyImported: existingUrls.has(v.url),
      }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return NextResponse.json({ streamerName: channel.display_name, videos });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
