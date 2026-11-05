import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { fmt } from "../providers/ai/longform-plan.js";

/**
 * Il transcript attorno all'inizio e alla fine di ogni video lungo di un VOD, per vedere se il taglio
 * cade a metà discorso (gratis). Uso: tsx src/dev/vod-cut-context.ts <video_id> [secondi prima] [secondi dopo]
 */
const [videoId, before = "90", after = "90"] = process.argv.slice(2);
const { data: t } = await supabase.from("transcripts").select("segments").eq("video_id", videoId!).single();
const segs = (t!.segments as Array<{ start: number; end: number; text: string }>).sort((a, b) => a.start - b.start);
const { data: clips } = await supabase.from("clips").select("id,start_time,end_time,title").eq("video_id", videoId!).eq("format", "longform").order("start_time");
const around = (at: number) =>
  segs
    .filter((s) => s.end > at - Number(before) && s.start < at + Number(after))
    .map((s) => `   ${s.start < at ? " " : ">"} [${fmt(s.start)}-${fmt(s.end)}] ${s.text.slice(0, 220)}`)
    .join("\n");
for (const c of clips ?? []) {
  console.log(`\n##### ${c.id.slice(0, 8)} ${c.title.slice(0, 80)}`);
  console.log(` INIZIO ${fmt(c.start_time)}\n${around(c.start_time)}`);
  console.log(` FINE ${fmt(c.end_time)}\n${around(c.end_time)}`);
}
