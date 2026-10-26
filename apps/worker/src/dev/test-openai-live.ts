import type Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { env } from "../env.js";
import { cachedSystemPrompt, createMessage, getAnthropicClient, logAnthropicCost, toolChoiceFor } from "../providers/ai/anthropic-client.js";

/**
 * Prova VERA del ponte Claude → OpenAI (costa: meno di 3 centesimi in tutto, autorizzata da simo il
 * 2026-10-25). Passa dallo stesso client che usano ranking, regia e mappa VOD.
 *   tsx src/dev/test-openai-live.ts sync    → 3 chiamate: Luna, Sol con immagine, Sol al secondo tentativo
 *   tsx src/dev/test-openai-live.ts batch   → 1 chiamata Luna tramite Batch API (minuti o ore)
 */
const mode = process.argv[2];
const client = getAnthropicClient(env.ANTHROPIC_API_KEY);

const pickTool: Anthropic.Tool = {
  name: "submit_pick",
  description: "Restituisce la frase più adatta a diventare uno Short",
  input_schema: {
    type: "object",
    properties: { index: { type: "integer", description: "Numero della frase scelta" }, reason: { type: "string" } },
    required: ["index", "reason"],
  },
};
const pickParams = (): Anthropic.MessageCreateParamsNonStreaming => ({
  model: env.ANTHROPIC_MODEL_CHEAP,
  max_tokens: 300,
  system: cachedSystemPrompt("Sei un editor di Shorts. Rispondi chiamando lo strumento submit_pick."),
  messages: [
    {
      role: "user",
      content: "Frasi di una live:\n1. ok ragazzi aspettate che bevo\n2. NO RAGA HO PRESO IL CAMPIONE PIÙ RARO DEL GIOCO\n3. vabbè andiamo avanti",
    },
  ],
  tools: [pickTool],
  tool_choice: toolChoiceFor(env.ANTHROPIC_MODEL_CHEAP, pickTool.name),
});

function toolInput(message: Anthropic.Message, name: string) {
  return message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === name);
}

if (mode === "sync") {
  // 1. Luna: prima scrematura con strumento obbligatorio
  const m1 = await client.messages.create(pickParams());
  logAnthropicCost("prova 1 Luna", m1.model, m1.usage);
  console.log("1 Luna →", m1.stop_reason, JSON.stringify(toolInput(m1, pickTool.name)?.input));

  // 2. Sol con un fotogramma, come la regia del pannello del gioco
  const svg = `<svg width="768" height="432" xmlns="http://www.w3.org/2000/svg"><rect width="768" height="432" fill="#1d4ed8"/><text x="384" y="240" font-size="96" font-family="Arial" font-weight="bold" fill="#ffffff" text-anchor="middle">VITTORIA</text></svg>`;
  const jpeg = (await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer()).toString("base64");
  const frameTool: Anthropic.Tool = {
    name: "describe_frame",
    description: "Descrive il fotogramma",
    input_schema: {
      type: "object",
      properties: { background: { type: "string", description: "Colore dello sfondo" }, text: { type: "string", description: "Testo scritto" } },
      required: ["background", "text"],
    },
  };
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Guarda il fotogramma." },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg } },
      ],
    },
  ];
  const frameParams = (): Anthropic.MessageCreateParamsNonStreaming => ({
    model: env.ANTHROPIC_MODEL_CONTENT_FOCUS,
    max_tokens: 300,
    system: cachedSystemPrompt("Descrivi i fotogrammi chiamando lo strumento describe_frame."),
    messages,
    tools: [frameTool],
    tool_choice: toolChoiceFor(env.ANTHROPIC_MODEL_CONTENT_FOCUS, frameTool.name),
  });
  const m2 = await client.messages.create(frameParams());
  logAnthropicCost("prova 2 Sol immagine", m2.model, m2.usage);
  const t2 = toolInput(m2, frameTool.name);
  console.log("2 Sol →", m2.stop_reason, JSON.stringify(t2?.input));

  // 3. Secondo tentativo come in ranking.ts: risposta rimandata + tool_result di errore
  if (!t2) throw new Error("La prova 2 non ha chiamato lo strumento, salto la 3");
  messages.push({ role: "assistant", content: m2.content });
  messages.push({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: t2.id, is_error: true, content: "Output non valido: scrivi il testo tutto in minuscolo. Richiama describe_frame." }],
  });
  const m3 = await client.messages.create(frameParams());
  logAnthropicCost("prova 3 Sol secondo tentativo", m3.model, m3.usage);
  console.log("3 Sol →", m3.stop_reason, JSON.stringify(toolInput(m3, frameTool.name)?.input));
} else if (mode === "batch") {
  // 4. Batch API, come mappa/confini/titoli dei VOD
  const m4 = await createMessage(client, pickParams(), { batch: true, label: "prova 4 batch" });
  logAnthropicCost("prova 4 Luna batch", m4.model, m4.usage);
  console.log("4 Batch →", m4.stop_reason, JSON.stringify(toolInput(m4, pickTool.name)?.input));
} else {
  console.error("Uso: tsx src/dev/test-openai-live.ts sync|batch");
  process.exit(1);
}
