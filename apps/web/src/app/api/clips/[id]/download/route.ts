import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPresignedDownloadUrl } from "@/lib/storage/r2";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const { data: clip, error: clipError } = await supabase
    .from("clips")
    .select("id, status, output_video_path")
    .eq("id", params.id)
    .single();

  if (clipError || !clip) {
    return NextResponse.json({ error: "Clip non trovata" }, { status: 404 });
  }
  if (clip.status !== "COMPLETED" || !clip.output_video_path) {
    return NextResponse.json({ error: "Clip non ancora pronta" }, { status: 409 });
  }

  try {
    const url = await getPresignedDownloadUrl(clip.output_video_path);
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Generazione URL fallita: ${message}` }, { status: 500 });
  }
}
