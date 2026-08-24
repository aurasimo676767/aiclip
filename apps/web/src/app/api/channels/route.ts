import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getValidYoutubeAccessToken, resolveYoutubeChannel } from "@/lib/youtube-scan";

const bodySchema = z.object({
  input: z.string().trim().min(1).max(200),
});

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido" }, { status: 400 });
  }

  const { data: connection } = await supabase.from("youtube_connections").select("*").eq("user_id", user.id).maybeSingle();
  if (!connection) {
    return NextResponse.json({ error: "Collega prima un account YouTube dalle Impostazioni" }, { status: 409 });
  }

  try {
    const accessToken = await getValidYoutubeAccessToken(supabase, connection);
    const channel = await resolveYoutubeChannel(parsed.data.input, accessToken);

    const { error: insertError } = await supabase.from("followed_channels").insert({
      user_id: user.id,
      channel_id: channel.channelId,
      channel_title: channel.channelTitle,
      uploads_playlist_id: channel.uploadsPlaylistId,
    });
    if (insertError) {
      if (insertError.code === "23505") {
        return NextResponse.json({ error: "Segui già questo canale" }, { status: 409 });
      }
      throw new Error(insertError.message);
    }

    return NextResponse.json({ ok: true, channelTitle: channel.channelTitle });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
