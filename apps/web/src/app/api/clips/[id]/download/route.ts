import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

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

  const admin = createSupabaseAdminClient();
  const bucket = process.env.STORAGE_BUCKET ?? "clipforge-media";
  const { data: signed, error: signError } = await admin.storage
    .from(bucket)
    .createSignedUrl(clip.output_video_path, 3600, { download: false });

  if (signError || !signed) {
    return NextResponse.json({ error: `Generazione URL fallita: ${signError?.message}` }, { status: 500 });
  }

  return NextResponse.json({ url: signed.signedUrl });
}
