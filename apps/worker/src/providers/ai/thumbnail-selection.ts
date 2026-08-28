import { getAnthropicClient } from "./anthropic-client.js";
import { logger } from "../../lib/logger.js";
import type Anthropic from "@anthropic-ai/sdk";

const TOOL_NAME = "return_thumbnail_selection";

const TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: "Restituisce la selezione di fotogrammi e il testo per comporre la copertina.",
  input_schema: {
    type: "object" as const,
    properties: {
      backgroundFrameIndex: {
        type: "integer",
        description:
          "Indice (0-based) del fotogramma migliore da usare come sfondo della copertina — il più interessante/leggibile/rappresentativo del contenuto. Evita fotogrammi sfocati, transizioni, schermate nere o di caricamento. EVITA fortemente fotogrammi dove si vede l'interfaccia del browser/player (barra di avanzamento video, controlli play/pausa, sidebar della chat Twitch, testo di commenti, titoli/pulsanti dell'interfaccia) — se proprio tutti i fotogrammi ce l'hanno, scegli quello con MENO interfaccia visibile e usa contentCropBox per tagliarla via.",
      },
      contentCropBox: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
        description:
          "Riquadro (frazioni 0-1) da ritagliare dal fotogramma di sfondo scelto per ESCLUDERE interfaccia/chat/controlli e tenere solo il contenuto vero (es. il video reagito, il gioco). Ometti se il fotogramma è già pulito (nessuna interfaccia visibile) e va usato per intero.",
      },
      reactedVideoQuery: {
        type: "string",
        description:
          "Se in uno dei fotogrammi è leggibile il titolo e/o il nome del canale del video che si sta reagendo (es. testo nella pagina YouTube, tab del browser, sottotitolo in sovrimpressione), scrivi qui una query di ricerca breve per ritrovarlo (titolo + canale). Serve per recuperare la SUA copertina ufficiale reale invece di uno screenshot improvvisato. Ometti/lascia vuoto se non è leggibile con sicurezza — meglio niente che una query sbagliata.",
      },
      desiredExpression: {
        type: "string",
        description:
          "Quale espressione della persona (tra quelle disponibili elencate nel messaggio) si adatta meglio al tono di questo segmento, in base a titolo/riassunto/descrizione — es. se il segmento è divertente scegli un'espressione che ride, se è imbarazzante/scioccante una scioccata, ecc. Scrivi ESATTAMENTE una delle etichette elencate. Ometti se nessuna delle disponibili si adatta meglio delle altre (verrà scelta a caso).",
      },
    },
    required: ["backgroundFrameIndex"],
  },
};

const SYSTEM_PROMPT = `Sei un editor esperto di copertine YouTube per video reaction/gameplay. Ti vengono mostrati alcuni fotogrammi campionati da un video già montato, numerati da 0 in ordine. Guardali e:

1. Scegli l'indice del fotogramma migliore da usare come SFONDO della copertina — MAI uno con interfaccia browser/player visibile (barra di avanzamento, controlli, sidebar chat, testo di commenti): se capita in tutti, scegli quello con meno interfaccia e ritagliala via con contentCropBox.
2. Se riesci a leggere con sicurezza il titolo o il canale del video/contenuto che si sta reagendo in uno dei fotogrammi, scrivilo in reactedVideoQuery.
3. Se ti vengono elencate espressioni disponibili per la persona in copertina, scegli quella più adatta al tono del segmento (desiredExpression).

Rispondi chiamando lo strumento ${TOOL_NAME}.`;

export interface ThumbnailSelectionOptions {
  apiKey: string;
  model: string;
  clipTitle: string;
  clipHook: string;
  clipCaption: string;
  /** Fotogrammi JPEG in base64, nello stesso ordine con cui vengono numerati nel prompt. */
  frameJpegsBase64: string[];
  /** Etichette espressione disponibili per la persona che comparirà in copertina (vedi listAvailableExpressions). */
  availableExpressions?: string[];
}

export interface ThumbnailSelection {
  backgroundFrameIndex: number;
  contentCropBox: { x: number; y: number; width: number; height: number } | null;
  reactedVideoQuery: string | null;
  desiredExpression: string | null;
}

export async function selectThumbnailAssets(options: ThumbnailSelectionOptions): Promise<ThumbnailSelection> {
  const client = getAnthropicClient(options.apiKey);

  const expressionsLine =
    options.availableExpressions && options.availableExpressions.length > 0
      ? `\nEspressioni disponibili per la persona in copertina: ${options.availableExpressions.join(", ")}`
      : "";

  const content: Anthropic.MessageParam["content"] = [
    {
      type: "text",
      text: `Video: "${options.clipTitle}"\nRiassunto: ${options.clipHook}\nDescrizione: ${options.clipCaption}${expressionsLine}`,
    },
  ];
  options.frameJpegsBase64.forEach((jpeg, index) => {
    content.push({ type: "text", text: `Fotogramma ${index}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg } });
  });

  const message = await client.messages.create({
    model: options.model,
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    tools: [TOOL_SCHEMA],
    tool_choice: { type: "tool", name: TOOL_NAME },
  });

  const toolUseBlock = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME,
  );
  if (!toolUseBlock) {
    throw new Error("Nessun output strutturato dalla selezione IA della copertina");
  }

  const input = toolUseBlock.input as {
    backgroundFrameIndex?: number;
    contentCropBox?: { x: number; y: number; width: number; height: number };
    reactedVideoQuery?: string;
    desiredExpression?: string;
  };

  if (typeof input.backgroundFrameIndex !== "number") {
    logger.warn("Output selezione copertina incompleto", { input });
    throw new Error("Output non valido dalla selezione IA della copertina");
  }

  return {
    backgroundFrameIndex: input.backgroundFrameIndex,
    contentCropBox: input.contentCropBox ?? null,
    reactedVideoQuery: input.reactedVideoQuery?.trim() ? input.reactedVideoQuery.trim() : null,
    desiredExpression: input.desiredExpression?.trim() ? input.desiredExpression.trim() : null,
  };
}
