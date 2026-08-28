import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchLatestVods } from "@/lib/twitch-scan";

const VODS_PER_CHANNEL = 6; // VOD Twitch = live intere, meno frequenti degli upload YouTube

export interface TwitchFeedVideo {
  vodId: string;
  vodUrl: string;
  title: string;
  thumbnailUrl: string;
  streamerName: string;
  streamerLogin: string;
  createdAt: string;
  durationSeconds: number;
  alreadyImported: boolean;
}

/**
 * Griglia dei VOD recenti dei canali Twitch seguiti — stesso ruolo di /api/channels/feed per
 * YouTube, ma senza bisogno di una connessione OAuth utente (vedi twitch-scan.ts). Nessun
 * import automatico: l'utente sceglie cosa generare cliccando "Genera" (vedi /api/projects/twitch).
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const { data: channels } = await supabase.from("followed_twitch_channels").select("*").eq("user_id", user.id);
  if (!channels || channels.length === 0) {
    return NextResponse.json({ videos: [] as TwitchFeedVideo[] });
  }

  try {
    const { data: userProjects } = await supabase.from("projects").select("id").eq("user_id", user.id);
    const projectIds = (userProjects ?? []).map((p) => p.id);
    const { data: existingVideos } =
      projectIds.length > 0 ? await supabase.from("videos").select("source_url").in("project_id", projectIds) : { data: [] };
    const existingUrls = new Set((existingVideos ?? []).map((v) => v.source_url).filter(Boolean));

    const perChannel = await Promise.all(
      channels.map(async (channel) => {
        try {
          const vods = await fetchLatestVods(channel.twitch_user_id, VODS_PER_CHANNEL);
          return vods.map((v) => ({ ...v, streamerName: channel.display_name, streamerLogin: channel.login }));
        } catch {
          return []; // un canale che fallisce non deve far fallire l'intero feed
        }
      }),
    );

    const videos: TwitchFeedVideo[] = perChannel
      .flat()
      .map((v) => ({
        vodId: v.vodId,
        vodUrl: v.url,
        title: v.title,
        thumbnailUrl: v.thumbnailUrl,
        streamerName: v.streamerName,
        streamerLogin: v.streamerLogin,
        createdAt: v.createdAt,
        durationSeconds: v.durationSeconds,
        alreadyImported: existingUrls.has(v.url),
      }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return NextResponse.json({ videos });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
