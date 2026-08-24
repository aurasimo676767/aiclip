import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getValidYoutubeAccessToken, fetchLatestUploads } from "@/lib/youtube-scan";

const VIDEOS_PER_CHANNEL = 3; // quanti upload recenti guardiamo per canale ad ogni scan
const MAX_IMPORTS_PER_SCAN = 5; // tetto per scan: costi AI a valle prevedibili anche con molti canali seguiti

/**
 * Controlla i canali seguiti per video nuovi e li importa nella pipeline esistente — stessa
 * identica strada dell'import manuale da URL (stesso progetto/video, stessa coda worker,
 * nessuna logica AI nuova). Il costo Claude non si spende qui: si spende dopo, quando il
 * worker processa ogni video importato (Haiku candidati + Sonnet/Opus ranking).
 */
export async function POST() {
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
    return NextResponse.json({ error: "Non segui ancora nessun canale" }, { status: 409 });
  }

  try {
    const accessToken = await getValidYoutubeAccessToken(supabase, connection);

    // Video già importati da questo utente (qualunque provenienza), per non re-importare.
    const { data: userProjects } = await supabase.from("projects").select("id").eq("user_id", user.id);
    const projectIds = (userProjects ?? []).map((p) => p.id);
    const { data: existingVideos } =
      projectIds.length > 0 ? await supabase.from("videos").select("source_url").in("project_id", projectIds) : { data: [] };
    const existingUrls = new Set((existingVideos ?? []).map((v) => v.source_url).filter(Boolean));

    const imported: string[] = [];
    let newVideosFound = 0;

    for (const channel of channels) {
      if (imported.length >= MAX_IMPORTS_PER_SCAN) break;

      let uploads;
      try {
        uploads = await fetchLatestUploads(channel.uploads_playlist_id, accessToken, VIDEOS_PER_CHANNEL);
      } catch {
        continue; // un canale che fallisce non deve bloccare gli altri
      }

      for (const video of uploads) {
        const url = `https://www.youtube.com/watch?v=${video.videoId}`;
        if (existingUrls.has(url)) continue;
        newVideosFound++;
        if (imported.length >= MAX_IMPORTS_PER_SCAN) continue;

        const { data: project, error: projectError } = await supabase
          .from("projects")
          .insert({ user_id: user.id, title: video.title || "Importazione da YouTube...", source_type: "youtube_url", status: "UPLOADED" })
          .select()
          .single();
        if (projectError || !project) continue;

        const { error: videoError } = await supabase
          .from("videos")
          .insert({ project_id: project.id, original_filename: video.title || url, source_url: url, status: "UPLOADED" });
        if (videoError) {
          await supabase.from("projects").delete().eq("id", project.id);
          continue;
        }

        existingUrls.add(url);
        imported.push(video.title || url);
      }
    }

    return NextResponse.json({ channelsScanned: channels.length, newVideosFound, imported });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
