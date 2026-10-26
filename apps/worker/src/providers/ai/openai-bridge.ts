import OpenAI, { toFile } from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../env.js";
import { logger } from "../../lib/logger.js";

/**
 * Ponte Claude → OpenAI (2026-10-25, credito Anthropic finito): prende una richiesta nel formato
 * Messages di Anthropic, la manda a un modello GPT con la Responses API e restituisce la risposta
 * nel formato Anthropic. Così i punti che chiamano l'AI (ranking, mappa VOD, regia, copertine...)
 * restano identici e cambia solo il modello scelto in env.ts (AI_PROVIDER).
 *
 * Responses e non Chat Completions: GPT-6.1 Sol usa gli strumenti solo lì.
 */

export function isOpenAIModel(model: string): boolean {
  return /^(gpt-|o\d)/.test(model);
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  // Timeout largo: la mappa di un VOD manda 200-260mila token in una sola chiamata.
  if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 20 * 60 * 1000, maxRetries: 2 });
  return client;
}

/**
 * Da OpenAI il limite di output comprende anche il ragionamento, che Claude qui non faceva: i
 * max_tokens dei chiamanti sono pensati per la sola risposta. Si aggiunge margine, che non costa
 * niente (si pagano i token prodotti, non il limite) ed evita risposte tagliate da rifare.
 */
const REASONING_HEADROOM = 32_000;
const MAX_OUTPUT_TOKENS = 128_000;

// Gli elementi originali della risposta (ragionamento cifrato compreso) viaggiano attaccati al
// contenuto convertito: quando un chiamante rimanda `message.content` per un nuovo tentativo,
// OpenAI vuole rivedere il ragionamento insieme alla chiamata allo strumento.
const RAW_OUTPUT = Symbol("openaiOutput");
type ContentWithRaw = Anthropic.ContentBlock[] & { [RAW_OUTPUT]?: unknown[] };

type ResponsesBody = Record<string, unknown>;

interface ResponsesResult {
  id: string;
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{
    type: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
}

function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  const text =
    typeof block.content === "string"
      ? block.content
      : (block.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
  return block.is_error ? `Errore: ${text}` : text;
}

function userItems(content: Anthropic.MessageParam["content"]): unknown[] {
  if (typeof content === "string") return [{ role: "user", content: [{ type: "input_text", text: content }] }];
  // I risultati degli strumenti vanno subito dopo la chiamata a cui rispondono, il resto del
  // messaggio dell'utente dopo.
  const items: unknown[] = [];
  const parts: unknown[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push({ type: "input_text", text: block.text });
    else if (block.type === "image") {
      parts.push({ type: "input_image", image_url: `data:${block.source.media_type};base64,${block.source.data}`, detail: "auto" });
    } else if (block.type === "tool_result") {
      items.push({ type: "function_call_output", call_id: block.tool_use_id, output: toolResultText(block) });
    } else throw new Error(`Blocco "${block.type}" non supportato dal ponte OpenAI`);
  }
  if (parts.length) items.push({ role: "user", content: parts });
  return items;
}

function assistantItems(content: Anthropic.MessageParam["content"]): unknown[] {
  if (typeof content === "string") return [{ role: "assistant", content }];
  const raw = (content as ContentWithRaw)[RAW_OUTPUT];
  if (raw) return raw;
  const items: unknown[] = [];
  for (const block of content) {
    if (block.type === "text") items.push({ role: "assistant", content: block.text });
    else if (block.type === "tool_use") {
      items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
    } else throw new Error(`Blocco "${block.type}" non supportato dal ponte OpenAI`);
  }
  return items;
}

function toolChoice(choice: Anthropic.MessageCreateParams["tool_choice"]): unknown {
  if (!choice || choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  return { type: "function", name: choice.name };
}

export function toResponsesBody(params: Anthropic.MessageCreateParamsNonStreaming): ResponsesBody {
  const system = typeof params.system === "string" ? params.system : (params.system ?? []).map((block) => block.text).join("\n\n");
  const input = params.messages.flatMap((message) => (message.role === "user" ? userItems(message.content) : assistantItems(message.content)));
  const body: ResponsesBody = {
    model: params.model,
    input,
    max_output_tokens: Math.min(MAX_OUTPUT_TOKENS, params.max_tokens + REASONING_HEADROOM),
    reasoning: { effort: env.OPENAI_REASONING_EFFORT },
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  if (system) body.instructions = system;
  // Sconto del 90% sui token del prefisso già visto (istruzioni e strumenti, identici a ogni chiamata
  // dello stesso tipo): la chiave fa arrivare le richieste uguali alla stessa macchina, dove il prefisso
  // è in cache. Prima scattava in 8 chiamate su 74 (log del 25-26/10/2026).
  body.prompt_cache_key = createHash("sha1")
    .update(JSON.stringify([params.model, system, (params.tools ?? []).map((t) => t.name)]))
    .digest("hex")
    .slice(0, 32);
  if (params.tools?.length) {
    body.tools = params.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      // Gli schemi sono scritti per Claude (campi facoltativi, niente additionalProperties): in
      // modalità strict OpenAI li riscriverebbe o li rifiuterebbe.
      strict: false,
    }));
    body.tool_choice = toolChoice(params.tool_choice);
  }
  return body;
}

export function toAnthropicMessage(res: ResponsesResult, model: string): Anthropic.Message {
  if (res.status === "failed") throw new Error(`OpenAI: risposta fallita (${res.error?.message ?? "motivo non indicato"})`);
  const content = [] as unknown as ContentWithRaw;
  let calledTool = false;
  for (const item of res.output ?? []) {
    if (item.type === "function_call") {
      calledTool = true;
      let input: unknown = {};
      try {
        input = JSON.parse(item.arguments ?? "{}");
      } catch {
        // Input vuoto: lo schema del chiamante lo boccia e si riprova come con un output sbagliato di Claude.
        logger.warn("OpenAI: argomenti dello strumento non in JSON", { name: item.name, raw: (item.arguments ?? "").slice(0, 500) });
      }
      content.push({ type: "tool_use", id: item.call_id ?? "", name: item.name ?? "", input } as Anthropic.ToolUseBlock);
    } else if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") content.push({ type: "text", text: part.text ?? "" } as Anthropic.TextBlock);
      }
    }
  }
  content[RAW_OUTPUT] = res.output ?? [];
  const truncated = res.status === "incomplete" && res.incomplete_details?.reason === "max_output_tokens";
  // Da OpenAI input_tokens comprende anche quelli letti dalla cache, da Anthropic no: si separano
  // per non pagarli due volte nei conti.
  const cached = res.usage?.input_tokens_details?.cached_tokens ?? 0;
  const usage = {
    input_tokens: (res.usage?.input_tokens ?? 0) - cached,
    output_tokens: res.usage?.output_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
  return {
    id: res.id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: truncated ? "max_tokens" : calledTool ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage,
  } as Anthropic.Message;
}

/**
 * Cache del prefisso tenuta 24 ore invece di pochi minuti: le chiamate dello stesso tipo (regia di uno
 * Short, scelta della copertina) arrivano a distanza di ore. Se il modello non la accetta si toglie e
 * non la si chiede più fino al riavvio.
 */
let longCacheRetention = true;

export async function openaiCreate(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  const body = toResponsesBody(params);
  if (longCacheRetention) body.prompt_cache_retention = "24h";
  try {
    const res = await getClient().responses.create(body as never);
    return toAnthropicMessage(res as unknown as ResponsesResult, params.model);
  } catch (error) {
    if (!longCacheRetention || !(error instanceof Error) || !/prompt_cache_retention/i.test(error.message)) throw error;
    longCacheRetention = false;
    logger.warn("OpenAI: cache di 24 ore non accettata da questo modello, resta quella normale", { model: params.model, error: error.message.slice(0, 200) });
    delete body.prompt_cache_retention;
    const res = await getClient().responses.create(body as never);
    return toAnthropicMessage(res as unknown as ResponsesResult, params.model);
  }
}

/** Quanto si aspetta un batch prima di rinunciare e fare la chiamata normale (a prezzo pieno). */
const BATCH_MAX_WAIT_MS = 2 * 60 * 60 * 1000;
const BATCH_FINAL = ["completed", "failed", "expired", "cancelled"];

/**
 * Come createMessage di anthropic-client.ts, ma con la Batch API di OpenAI: metà prezzo, da qualche
 * minuto a qualche ora. Stessa memoria su disco per non pagare due volte se il worker riparte a
 * metà, stesso ripiego sulla chiamata normale se il batch non finisce o non riesce.
 */
export async function openaiCreateMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts: { batch?: boolean; label?: string } = {},
): Promise<Anthropic.Message> {
  if (!opts.batch) return openaiCreate(params);

  const openai = getClient();
  const body = toResponsesBody(params);
  const started = Date.now();
  let batchId: string | undefined;
  const memoDir = path.join(env.WORKER_TMP_DIR, "batches");
  const memoFile = path.join(memoDir, `openai-${createHash("sha1").update(JSON.stringify(body)).digest("hex")}.txt`);
  try {
    let batch: OpenAI.Batches.Batch | null = null;
    const remembered = fs.existsSync(memoFile) ? fs.readFileSync(memoFile, "utf8").trim() : "";
    if (remembered) {
      const old = await openai.batches.retrieve(remembered).catch(() => null);
      if (old && ["validating", "in_progress", "finalizing", "completed"].includes(old.status)) {
        batch = old;
        logger.info("Batch ripreso dopo un riavvio (nessun doppio pagamento)", { label: opts.label, batchId: old.id });
      }
    }
    if (!batch) {
      const line = JSON.stringify({ custom_id: "r1", method: "POST", url: "/v1/responses", body });
      const file = await openai.files.create({ file: await toFile(Buffer.from(`${line}\n`), "richiesta.jsonl"), purpose: "batch" });
      batch = await openai.batches.create({ input_file_id: file.id, endpoint: "/v1/responses" as never, completion_window: "24h" });
      fs.mkdirSync(memoDir, { recursive: true });
      fs.writeFileSync(memoFile, batch.id);
    }
    batchId = batch.id;
    let wait = 15_000;
    while (!BATCH_FINAL.includes(batch.status)) {
      if (Date.now() - started > BATCH_MAX_WAIT_MS) throw new Error("batch troppo lento");
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 1.5, 60_000);
      batch = await openai.batches.retrieve(batch.id);
    }
    if (batch.status !== "completed" || !batch.output_file_id) throw new Error(`batch ${batch.status}, nessun risultato`);
    const text = await (await openai.files.content(batch.output_file_id)).text();
    const row = JSON.parse(text.trim().split("\n")[0] ?? "{}") as {
      response?: { status_code?: number; body?: ResponsesResult } | null;
      error?: { message?: string } | null;
    };
    if (row.error || row.response?.status_code !== 200 || !row.response.body) {
      throw new Error(`batch: ${row.error?.message ?? `stato ${row.response?.status_code}`}`);
    }
    fs.rmSync(memoFile, { force: true });
    logger.info("Chiamata via batch completata (prezzo -50%)", { label: opts.label, model: params.model, minuti: ((Date.now() - started) / 60000).toFixed(1) });
    return toAnthropicMessage(row.response.body, params.model);
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
    logger.warn("Batch non riuscito, si rifà la chiamata normale (prezzo pieno)", {
      label: opts.label,
      batchId,
      error: error instanceof Error ? error.message : String(error),
      cause,
    });
    if (batchId) await openai.batches.cancel(batchId).catch(() => undefined);
    fs.rmSync(memoFile, { force: true });
    return openaiCreate(params);
  }
}
