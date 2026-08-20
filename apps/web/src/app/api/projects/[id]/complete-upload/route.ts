import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({ videoId: z.string().uuid() });

export async function POST(request: Request, { params }: { params: { id: string } }) {
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
    return NextResponse.json({ error: "Payload non valido" }, { status: 400 });
  }

  const { data: video, error: videoError } = await supabase
    .from("videos")
    .select("id, project_id, storage_path")
    .eq("id", parsed.data.videoId)
    .eq("project_id", params.id)
    .single();

  if (videoError || !video) {
    return NextResponse.json({ error: "Video non trovato" }, { status: 404 });
  }
  if (!video.storage_path) {
    return NextResponse.json({ error: "Upload non completato: storage_path mancante" }, { status: 400 });
  }

  const { error: updateVideoError } = await supabase.from("videos").update({ status: "UPLOADED" }).eq("id", video.id);
  if (updateVideoError) {
    return NextResponse.json({ error: updateVideoError.message }, { status: 500 });
  }

  const { error: updateProjectError } = await supabase
    .from("projects")
    .update({ status: "UPLOADED" })
    .eq("id", params.id);
  if (updateProjectError) {
    return NextResponse.json({ error: updateProjectError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
