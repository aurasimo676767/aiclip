import fsp from "node:fs/promises";
import { env } from "../env.js";
import { selectThumbnailAssets } from "../providers/ai/thumbnail-selection.js";
import { listAvailableExpressions } from "../providers/ai/generate-face-portrait.js";

const framePaths = process.argv.slice(2);
if (framePaths.length === 0) {
  console.error("Uso: tsx src/dev/test-expression-selection.ts <frame1.jpg> [frame2.jpg ...]");
  process.exit(1);
}

const frameJpegsBase64 = await Promise.all(framePaths.map(async (p) => (await fsp.readFile(p)).toString("base64")));
const availableExpressions = await listAvailableExpressions("blur");
console.log("Espressioni disponibili:", availableExpressions);

const selection = await selectThumbnailAssets({
  apiKey: env.ANTHROPIC_API_KEY,
  model: env.ANTHROPIC_MODEL_CHEAP,
  clipTitle: "BLUR REACTION: il momento più divertente della serata",
  clipHook: "Blur scoppia a ridere per una battuta assurda del gioco, non riesce a fermarsi per un minuto intero.",
  clipCaption: "Un momento esilarante in cui Blur non riesce a smettere di ridere dopo un fail clamoroso.",
  frameJpegsBase64,
  availableExpressions,
});

console.log("Risultato:", JSON.stringify(selection, null, 2));
