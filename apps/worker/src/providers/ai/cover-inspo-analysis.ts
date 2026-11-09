import fsp from "node:fs/promises";
import sharp from "sharp";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, toolChoiceFor, logAnthropicCost } from "./anthropic-client.js";
import type { InspoAnalysis } from "../../lib/cover-inspo.js";

/**
 * Studia UNA copertina di un canale (vedi lib/cover-inspo.ts): cosa c'è scritto, che scena, come è
 * impaginata e perché attira il clic. Non dice mai CHI sono le persone: conta solo cosa fanno.
 * Con GPT-6 Luna ~0,03 centesimi a copertina (immagine a 768 px).
 */

const TOOL = "describe_thumbnail";

const SYSTEM = `Sei un art director di copertine YouTube per canali italiani di clip di streamer (reaction e giochi). Ti mostro UNA copertina vera, col titolo del video. Studiala per poterne rifare di simili, e descrivila chiamando lo strumento ${TOOL}.
Non dire mai chi sono le persone né indovinarne il nome: descrivi solo cosa fanno, come sono messe e che espressione hanno.
- text: la scritta GRANDE della copertina, esattamente come è scritta (maiuscole, punti, lettere allungate); vuota se non c'è. Ignora loghi di canali e scritte minuscole.
- textStyle (in inglese): font, colori di ogni riga, contorno, effetti, posizione.
- scene (in inglese, 1-3 frasi concrete): cosa si vede e cosa fanno le persone, sfondo, oggetti, costumi, dettagli divertenti.
- composition (in inglese, 1 frase): dove stanno persone, scritta e oggetti principali, quanto spazio occupano.
- hook (in italiano, 1 frase): perché viene voglia di cliccare (curiosità, conflitto, assurdità, promessa...).`;

const toolSchema = {
  name: TOOL,
  description: "Descrizione della copertina.",
  input_schema: {
    type: "object" as const,
    properties: {
      kind: { type: "string", enum: ["reaction", "game", "altro"], description: "reaction = guardano un video/contenuto di altri; game = giocano (anche quiz e tornei)." },
      game: { type: "string", description: "Nome del gioco se si riconosce (dal titolo o dall'immagine), altrimenti stringa vuota." },
      text: { type: "string", description: "Stringa vuota se non c'è una scritta grande." },
      textStyle: { type: "string" },
      people: { type: "integer", description: "Quante persone in primo piano." },
      expressions: { type: "string", description: "In inglese: espressioni e pose (es. 'both shocked, hands on head')." },
      scene: { type: "string" },
      composition: { type: "string" },
      hook: { type: "string" },
    },
    required: ["kind", "game", "text", "textStyle", "people", "expressions", "scene", "composition", "hook"],
  },
};

export async function analyzeInspoCover(coverPath: string, title: string, options: { apiKey: string; model: string }): Promise<InspoAnalysis> {
  const client = getAnthropicClient(options.apiKey);
  const jpeg = await sharp(await fsp.readFile(coverPath)).resize(768, 432, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
  const content: Anthropic.MessageParam["content"] = [
    { type: "text", text: `Titolo del video: "${title}"` },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
  ];
  const msg = await client.messages.create({
    model: options.model,
    max_tokens: 800,
    system: SYSTEM,
    messages: [{ role: "user", content }],
    tools: [toolSchema as unknown as Anthropic.Tool],
    tool_choice: toolChoiceFor(options.model, TOOL),
  });
  logAnthropicCost("studio copertina di un canale", options.model, msg.usage);
  const tool = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL);
  const input = tool?.input as Partial<InspoAnalysis> | undefined;
  if (!input?.scene) throw new Error("Nessuna descrizione dalla copertina");
  return {
    kind: input.kind === "reaction" || input.kind === "game" ? input.kind : "altro",
    game: (typeof input.game === "string" && input.game.trim()) || null,
    text: (typeof input.text === "string" && input.text.trim()) || null,
    textStyle: input.textStyle ?? "",
    people: typeof input.people === "number" ? input.people : 0,
    expressions: input.expressions ?? "",
    scene: input.scene,
    composition: input.composition ?? "",
    hook: input.hook ?? "",
  };
}
