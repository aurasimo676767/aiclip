import type Anthropic from "@anthropic-ai/sdk";
import { classifyModelTier, computeModelCostUsd } from "@clipforge/shared";
import { env } from "../env.js";
import { cachedSystemPrompt, toolChoiceFor } from "../providers/ai/anthropic-client.js";
import { toAnthropicMessage, toResponsesBody } from "../providers/ai/openai-bridge.js";

/**
 * Prova del ponte Claude → OpenAI SENZA chiamare l'API (gratis): traduce una richiesta come quella
 * del ranking, una risposta finta di OpenAI e il secondo tentativo dopo un output sbagliato.
 * Uso: tsx src/dev/test-openai-bridge.ts
 */
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "OK " : "ERR"} ${label}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
}

console.log("Modelli:", {
  cheap: env.ANTHROPIC_MODEL_CHEAP,
  strong: env.ANTHROPIC_MODEL_STRONG,
  longform: env.ANTHROPIC_MODEL_LONGFORM,
  boundaries: env.ANTHROPIC_MODEL_LONGFORM_BOUNDARIES,
  edit: env.ANTHROPIC_MODEL_LONGFORM_EDIT,
  games: env.ANTHROPIC_MODEL_GAME_DETECT,
  focus: env.ANTHROPIC_MODEL_CONTENT_FOCUS,
  effort: env.OPENAI_REASONING_EFFORT,
});

const tool: Anthropic.Tool = {
  name: "submit_clips",
  description: "Restituisce le clip scelte",
  input_schema: { type: "object", properties: { clips: { type: "array", items: { type: "object" } } }, required: ["clips"] },
};
const messages: Anthropic.MessageParam[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Video: \"prova\"" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
    ],
  },
];
const params: Anthropic.MessageCreateParamsNonStreaming = {
  model: env.ANTHROPIC_MODEL_STRONG,
  max_tokens: 8000,
  system: cachedSystemPrompt("Sei un editor."),
  messages,
  tools: [tool],
  tool_choice: toolChoiceFor(env.ANTHROPIC_MODEL_STRONG, tool.name),
};

const body = toResponsesBody(params) as Record<string, any>;
check("istruzioni = prompt di sistema", body.instructions === "Sei un editor.", body.instructions);
check("limite output con margine", body.max_output_tokens === 40000, body.max_output_tokens);
check("strumento tradotto", body.tools?.[0]?.type === "function" && body.tools[0].parameters === tool.input_schema && body.tools[0].strict === false, body.tools);
check("strumento obbligatorio", body.tool_choice?.type === "function" && body.tool_choice.name === "submit_clips", body.tool_choice);
check("testo utente", body.input[0].content[0].type === "input_text", body.input[0]);
check("immagine come data URL", body.input[0].content[1].image_url === "data:image/jpeg;base64,QUJD", body.input[0].content[1]);
check("niente temperature/max_tokens", !("temperature" in body) && !("max_tokens" in body));

// Risposta finta: ragionamento + chiamata allo strumento, 1000 token in ingresso di cui 600 dalla cache
const fake = {
  id: "resp_1",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_1", encrypted_content: "xyz", summary: [] },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "submit_clips", arguments: "{\"clips\":[{\"title\":\"A\"}]}" },
  ],
  usage: { input_tokens: 1000, output_tokens: 300, input_tokens_details: { cached_tokens: 600 } },
};
const message = toAnthropicMessage(fake, params.model);
const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "submit_clips");
check("tool_use letto", JSON.stringify(toolUse?.input) === "{\"clips\":[{\"title\":\"A\"}]}", toolUse);
check("id della chiamata", toolUse?.id === "call_1", toolUse?.id);
check("stop_reason tool_use", message.stop_reason === "tool_use", message.stop_reason);
const usage = message.usage as Anthropic.Usage & { cache_read_input_tokens?: number };
check("token: cache separata", usage.input_tokens === 400 && usage.cache_read_input_tokens === 600 && usage.output_tokens === 300, usage);

// Secondo tentativo come in ranking.ts: assistant con la risposta + tool_result di errore
messages.push({ role: "assistant", content: message.content });
messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse!.id, is_error: true, content: "Output non valido" }] });
const retry = toResponsesBody(params) as Record<string, any>;
const types = retry.input.map((i: any) => i.type ?? `msg:${i.role}`);
check("ordine secondo tentativo", JSON.stringify(types) === JSON.stringify(["msg:user", "reasoning", "function_call", "function_call_output"]), types);
check("ragionamento rimandato", retry.input[1].encrypted_content === "xyz");
check("risposta allo strumento", retry.input[3].call_id === "call_1" && retry.input[3].output === "Errore: Output non valido", retry.input[3]);

// Risposta tagliata dal limite
const cut = toAnthropicMessage({ id: "r2", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }, params.model);
check("risposta tagliata = max_tokens", cut.stop_reason === "max_tokens", cut.stop_reason);

// Argomenti non JSON: input vuoto, lo schema del chiamante lo boccia
const broken = toAnthropicMessage({ id: "r3", status: "completed", output: [{ type: "function_call", call_id: "c", name: "submit_clips", arguments: "{rotto" }] }, params.model);
check("JSON rotto non fa crashare", JSON.stringify((broken.content[0] as Anthropic.ToolUseBlock).input) === "{}");

// Costi
check("tier Sol", classifyModelTier("gpt-6.1-sol") === "sol", classifyModelTier("gpt-6.1-sol"));
check("tier Luna", classifyModelTier("gpt-6-luna") === "luna", classifyModelTier("gpt-6-luna"));
check("tier Sonnet invariato", classifyModelTier("claude-sonnet-5") === "sonnet");
const cost = computeModelCostUsd("sol", { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 0, calls: 1 });
check("costo Sol: 1M in + 1M cache + 100k out = $3,10", Math.abs(cost - 3.1) < 1e-9, cost);
const sonnet = computeModelCostUsd("sonnet", { input: 1_000_000, output: 0, cacheRead: 1_000_000, cacheWrite: 0, calls: 1 });
check("costo Sonnet invariato ($2 + $0,20)", Math.abs(sonnet - 2.2) < 1e-9, sonnet);

console.log(failures ? `\n${failures} controlli falliti` : "\nTutti i controlli passati");
process.exit(failures ? 1 : 0);
