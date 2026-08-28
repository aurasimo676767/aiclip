import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveTwitchChannel } from "@/lib/twitch-scan";

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

  try {
    const channel = await resolveTwitchChannel(parsed.data.input);

    const { error: insertError } = await supabase.from("followed_twitch_channels").insert({
      user_id: user.id,
      twitch_user_id: channel.twitchUserId,
      login: channel.login,
      display_name: channel.displayName,
    });
    if (insertError) {
      if (insertError.code === "23505") {
        return NextResponse.json({ error: "Segui già questo canale" }, { status: 409 });
      }
      throw new Error(insertError.message);
    }

    return NextResponse.json({ ok: true, displayName: channel.displayName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
