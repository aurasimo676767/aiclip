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
          "Una frase COMPLETA e AUTONOMA di 6-12 parole, capibile da sola anche da chi non ha letto la descrizione — stile titolo clickbait da copertina YouTube (es. \"Scappa da 100 poliziotti e vince 500.000€\", non un frammento come \"e vince 500.000€\"). Deve avere soggetto sottinteso + un fatto/numero/azione concreta e sorprendente, non un dettaglio isolato fuori contesto. Verrà scritto in grande sulla copertina. Niente tutto maiuscolo (lo gestisce il rendering), niente punteggiatura finale.",
      },
    },
    required: ["backgroundFrameIndex", "faceFrameIndex", "headlineText"],
  },
};

const SYSTEM_PROMPT = `Sei un editor esperto di copertine YouTube per video reaction/gameplay. Ti vengono mostrati alcuni fotogrammi campionati da un video già montato, numerati da 0 in ordine. Guardali e:

1. Scegli l'indice del fotogramma migliore da usare come SFONDO della copertina — MAI uno con interfaccia browser/player visibile (barra di avanzamento, controlli, sidebar chat, testo di commenti): se capita in tutti, scegli quello con meno interfaccia e ritagliala via con contentCropBox.
2. Se in uno o più fotogrammi è visibile la webcam/faccia della persona che guarda/gioca, scegli quello con l'espressione più marcata; altrimenti -1.
3. Se hai scelto un fotogramma con faccia, indica un riquadro approssimativo attorno a testa/spalle.
4. Scrivi una frase ad effetto COMPLETA e autonoma (headlineText) — deve reggere da sola, non un dettaglio isolato staccato dal contesto (vedi descrizione del campo per un esempio).

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
  contentCropBox: { x: number; y: number; width: number; height: number } | null;
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
    contentCropBox?: { x: number; y: number; width: number; height: number };
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
    contentCropBox: input.contentCropBox ?? null,
    faceFrameIndex,
    faceBoundingBox: faceFrameIndex !== null && input.faceBoundingBox ? input.faceBoundingBox : null,
    headlineText: input.headlineText,
  };
}
