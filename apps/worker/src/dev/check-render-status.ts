import "dotenv/config";
import { supabase } from "../lib/supabase.js";

async function main() {
  const { data: jobs, error } = await supabase
    .from("render_jobs")
    .select("id,clip_id,status,stage,progress,attempts,error_message,claimed_by,claimed_at,started_at,created_at")
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw error;

  for (const j of jobs ?? []) {
    console.log(
      `${j.id}  clip=${j.clip_id}  [${j.status}] stage=${j.stage} progress=${j.progress}% attempts=${j.attempts} claimed_by=${j.claimed_by} claimed_at=${j.claimed_at} started_at=${j.started_at} error=${j.error_message ?? ""}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
