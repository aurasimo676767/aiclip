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
          "Indice (0-based) del fotogramma migliore da usare come sfondo della copertina — il più interessante/leggibile/rappresentativo del contenuto. Evita fotogrammi sfocati, transizioni, schermate nere o di caricamento.",
      },
      faceFrameIndex: {
        type: "integer",
        description:
          "Indice del fotogramma con l'espressione più marcata/scioccata/divertita sulla webcam della persona che guarda/gioca (di solito in un angolo dello schermo). -1 se in NESSUN fotogramma è visibile chiaramente una faccia.",
      },
      faceBoundingBox: {
        type: "object",
        properties: {
          x: { type: "number", description: "Bordo sinistro del riquadro, come frazione 0-1 della larghezza del fotogramma." },
          y: { type: "number", description: "Bordo superiore del riquadro, come frazione 0-1 dell'altezza del fotogramma." },
          width: { type: "number", description: "Larghezza del riquadro, come frazione 0-1 della larghezza del fotogramma." },
          height: { type: "number", description: "Altezza del riquadro, come frazione 0-1 dell'altezza del fotogramma." },
        },
        description:
          "Riquadro approssimativo attorno a testa/spalle della persona nel fotogramma scelto con faceFrameIndex — un po' più largo della sola faccia, per non tagliare capelli/spalle. Ometti se faceFrameIndex è -1.",
      },
      headlineText: {
        type: "string",
        description:
          "5-10 parole ad effetto in italiano, stile titolo clickbait da copertina YouTube, che riassumono il momento più interessante di questo segmento. Verrà scritto in grande sulla copertina: breve e d'impatto, non una frase completa. Niente tutto maiuscolo (lo gestisce il rendering), niente punteggiatura finale.",
      },
    },
    required: ["backgroundFrameIndex", "faceFrameIndex", "headlineText"],
  },
};

const SYSTEM_PROMPT = `Sei un editor esperto di copertine YouTube per video reaction/gameplay. Ti vengono mostrati alcuni fotogrammi campionati da un video già montato, numerati da 0 in ordine. Guardali e:

1. Scegli l'indice del fotogramma migliore da usare come SFONDO della copertina.
2. Se in uno o più fotogrammi è visibile la webcam/faccia della persona che guarda/gioca, scegli quello con l'espressione più marcata; altrimenti -1.
3. Se hai scelto un fotogramma con faccia, indica un riquadro approssimativo attorno a testa/spalle.
4. Scrivi un titolo ad effetto (headlineText) che riassuma il momento più interessante.

Rispondi chiamando lo strumento ${TOOL_NAME}.`;

export interface ThumbnailSelectionOptions {
  apiKey: string;
  model: string;
  clipTitle: string;
  clipHook: string;
  clipCaption: string;
  /** Fotogrammi JPEG in base64, nello stesso ordine con cui vengono numerati nel prompt. */
  frameJpegsBase64: string[];
}

export interface ThumbnailSelection {
  backgroundFrameIndex: number;
  faceFrameIndex: number | null;
  faceBoundingBox: { x: number; y: number; width: number; height: number } | null;
  headlineText: string;
}

export async function selectThumbnailAssets(options: ThumbnailSelectionOptions): Promise<ThumbnailSelection> {
  const client = getAnthropicClient(options.apiKey);

  const content: Anthropic.MessageParam["content"] = [
    {
      type: "text",
      text: `Video: "${options.clipTitle}"\nRiassunto: ${options.clipHook}\nDescrizione: ${options.clipCaption}`,
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
    faceFrameIndex?: number;
    faceBoundingBox?: { x: number; y: number; width: number; height: number };
    headlineText?: string;
  };

  if (typeof input.backgroundFrameIndex !== "number" || typeof input.headlineText !== "string") {
    logger.warn("Output selezione copertina incompleto", { input });
    throw new Error("Output non valido dalla selezione IA della copertina");
  }

  const faceFrameIndex = typeof input.faceFrameIndex === "number" && input.faceFrameIndex >= 0 ? input.faceFrameIndex : null;

  return {
    backgroundFrameIndex: input.backgroundFrameIndex,
    faceFrameIndex,
    faceBoundingBox: faceFrameIndex !== null && input.faceBoundingBox ? input.faceBoundingBox : null,
    headlineText: input.headlineText,
  };
}
