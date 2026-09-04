import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isValidTimeString } from "@/lib/publish-schedule";

const MAX_TIMES_PER_FORMAT = 12;

const bodySchema = z.object({
  shortTimes: z.array(z.string()).max(MAX_TIMES_PER_FORMAT),
  longformTimes: z.array(z.string()).max(MAX_TIMES_PER_FORMAT),
});

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("publish_schedules")
    .select("short_times, longform_times")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    shortTimes: data?.short_times ?? [],
    longformTimes: data?.longform_times ?? [],
  });
}

export async function PUT(request: Request) {
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
  const { shortTimes, longformTimes } = parsed.data;

  for (const t of [...shortTimes, ...longformTimes]) {
    if (!isValidTimeString(t)) {
      return NextResponse.json({ error: `Orario non valido: "${t}" (formato atteso HH:MM)` }, { status: 400 });
    }
  }

  const { error } = await supabase.from("publish_schedules").upsert(
    {
      user_id: user.id,
      short_times: [...new Set(shortTimes)].sort(),
      longform_times: [...new Set(longformTimes)].sort(),
    },
    { onConflict: "user_id" },
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
