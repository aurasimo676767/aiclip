import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { computeModelCostUsd } from "@clipforge/shared";
import { rateFaceImages, type FaceRating } from "../providers/ai/rate-faces.js";
import { env } from "../env.js";

/**
 * Giudica le facce raccolte dalle copertine (harvest-cover-faces.ts), vedi providers/ai/rate-faces.ts.
 * A PAGAMENTO (Haiku, ~0,005 $ ogni 8 facce). Riprende da dove era rimasto (rating.json).
 * Uso: tsx src/dev/rate-faces.ts <cartella harvest>
 */
const dir = process.argv[2]!;
const facesDir = path.join(dir, "faces");
const outPath = path.join(dir, "rating.json");
const ratings: Record<string, FaceRating> = JSON.parse(await fsp.readFile(outPath, "utf8").catch(() => "{}"));
const files = (await fsp.readdir(facesDir)).filter((f) => f.endsWith(".png") && !ratings[f]);
console.log(`da giudicare: ${files.length}`);

let totalCost = 0;
// A blocchi da 80, salvando ogni volta: se si interrompe, riparte da dove era.
for (let i = 0; i < files.length; i += 80) {
  const chunk = files.slice(i, i + 80);
  const { ratings: got, usage } = await rateFaceImages(
    chunk.map((f) => path.join(facesDir, f)),
    { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL_CHEAP },
  );
  for (const [p, r] of got) ratings[path.basename(p)] = r;
  totalCost += computeModelCostUsd("haiku", usage);
  await fsp.writeFile(outPath, JSON.stringify(ratings, null, 1));
  console.log(`giudicate ${Object.keys(ratings).length}, costo finora ~${totalCost.toFixed(3)} $`);
}
const all = Object.values(ratings);
console.log(`totale ${all.length}, utilizzabili ${all.filter((r) => r.usable).length}, costo ~${totalCost.toFixed(3)} $`);
