import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getValidYoutubeAccessToken, fetchLatestUploads, fetchVideoViewCounts } from "@/lib/youtube-scan";

const VIDEOS_PER_CHANNEL = 8; // quanti upload recenti mostriamo per canale nella griglia

export interface FeedVideo {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  channelTitle: string;
  publishedAt: string;
  viewCount: number | null;
  alreadyImported: boolean;
}

/**
 * Griglia stile YouTube dei video recenti dei canali seguiti (miniatura, titolo,
 * visualizzazioni) — a differenza di /api/channels/scan, qui NON si importa nulla in
 * automatico: solo dati per la UI, l'utente sceglie cosa generare cliccando "Genera"
 * (stessa strada dell'import singolo da URL, vedi /api/projects/youtube).
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const { data: connection } = await supabase.from("youtube_connections").select("*").eq("user_id", user.id).maybeSingle();
  if (!connection) {
    return NextResponse.json({ error: "Collega prima un account YouTube dalle Impostazioni" }, { status: 409 });
  }

  const { data: channels } = await supabase.from("followed_channels").select("*").eq("user_id", user.id);
  if (!channels || channels.length === 0) {
    return NextResponse.json({ videos: [] as FeedVideo[] });
  }

  try {
    const accessToken = await getValidYoutubeAccessToken(supabase, connection);

    const { data: userProjects } = await supabase.from("projects").select("id").eq("user_id", user.id);
    const projectIds = (userProjects ?? []).map((p) => p.id);
    const { data: existingVideos } =
      projectIds.length > 0 ? await supabase.from("videos").select("source_url").in("project_id", projectIds) : { data: [] };
    const existingUrls = new Set((existingVideos ?? []).map((v) => v.source_url).filter(Boolean));

    const perChannel = await Promise.all(
      channels.map(async (channel) => {
        try {
          const uploads = await fetchLatestUploads(channel.uploads_playlist_id, accessToken, VIDEOS_PER_CHANNEL);
          return uploads.map((v) => ({ ...v, channelTitle: channel.channel_title }));
        } catch {
          return []; // un canale che fallisce non deve far fallire l'intero feed
        }
      }),
    );
    const flat = perChannel.flat();

    const viewCounts = await fetchVideoViewCounts(
      flat.map((v) => v.videoId),
      accessToken,
    );

    const videos: FeedVideo[] = flat
      .map((v) => ({
        videoId: v.videoId,
        title: v.title,
        thumbnailUrl: v.thumbnailUrl,
        channelTitle: v.channelTitle,
        publishedAt: v.publishedAt,
        viewCount: viewCounts.get(v.videoId) ?? null,
        alreadyImported: existingUrls.has(`https://www.youtube.com/watch?v=${v.videoId}`),
      }))
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

    return NextResponse.json({ videos });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
