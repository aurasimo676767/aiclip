import { getAnthropicClient, toolChoiceFor } from "./anthropic-client.js";
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
        enum: ["shock", "urlo", "risata", "rabbia", "paura", "mani_in_testa", "sospetto", "sorriso"],
        description: "Espressione delle facce in copertina che si adatta di più al tono del video.",
      },
      kind: {
        type: "string",
        enum: ["reaction", "game"],
        description: "reaction = guardano e commentano un video/contenuto di altri; game = giocano a un gioco (anche quiz, tornei, giochi web).",
      },
      gameName: {
        type: "string",
        description: "Solo per game: il nome ESATTO del gioco com'è sul negozio (es. \"Trivia Murder Party 3\", \"Call of Duty: Black Ops II\", \"skribbl.io\"), per trovarne la grafica ufficiale. Ometti per le reaction.",
      },
      coverWords: {
        type: "string",
        description: "SEMPRE: la SCRITTA della copertina, 1-3 parole (massimo 4 corte), vedi le regole nel prompt.",
      },
      coverColor: {
        type: "string",
        enum: ["giallo", "bianco", "rosso", "verde", "azzurro", "rosa", "arancio"],
        description: "Colore della scritta, a tema col gioco o col tono (es. horror rosso, gioco di prato verde, quiz giallo).",
      },
    },
    required: ["backgroundFrameIndex", "kind", "coverColor"],
  },
};

const SYSTEM_PROMPT = `Sei un editor esperto di copertine YouTube per video reaction/gameplay. Ti vengono mostrati alcuni fotogrammi campionati da un video già montato, numerati da 0 in ordine. Guardali e:

1. Scegli l'indice del fotogramma migliore da usare come SFONDO della copertina — MAI uno con interfaccia browser/player visibile (barra di avanzamento, controlli, sidebar chat, testo di commenti): se capita in tutti, scegli quello con meno interfaccia e ritagliala via con contentCropBox.
2. Se riesci a leggere con sicurezza il titolo o il canale del video/contenuto che si sta reagendo in uno dei fotogrammi, scrivilo in reactedVideoQuery.
3. Scegli l'espressione delle facce più adatta al tono (desiredExpression).
4. Dì se è una reaction o un gioco (kind); per un gioco scrivi il nome esatto del gioco (gameName).
5. Scrivi SEMPRE la SCRITTA della copertina (coverWords) e il colore (coverColor): per un gioco cosa succede nella partita, per una reaction o uno Short la battuta o la cosa assurda di cui si parla.

Regole della SCRITTA: 1-3 parole in italiano, come le scrivono i canali di clip italiani su Blur, Marza e Pesh. Esempi VERI che funzionano: "MEGA JEOPARDY", "GIOCHI BRUTTI", "SIAMO DOPPIATORI", "TELEFONATAAA", "DISTRUTTI A GOLF", "LA RUN PERFETTA?", "COME HA FATTO??", "MEGA POKERATA", "JEOPARDY CHEATER?!", "TORNEO TUTTI CONTRO TUTTI", "DIVENTIAMO MURATORI", "SONO GAY?", "ERA UN'IA?!", "BARBA INCOLLATA".
- Dice cosa succede o la battuta del video, con parole da ragazzi: niente "INCREDIBILE", "EPICO", "PAZZESCO", "SFIDA ESTREMA", "IMPERDIBILE", niente frasi da pubblicità o da giornale.
- Si può usare il nome del gioco se è corto e riconoscibile (MEGA JEOPARDY), punti di domanda o esclamativi alla fine, lettere allungate (TELEFONATAAA).
- Niente emoji, niente nomi degli streamer (le loro facce sono già in copertina).

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
  reactedVideoQuery: string | null;
  desiredExpression: string | null;
  kind: "reaction" | "game";
  gameName: string | null;
  coverWords: string | null;
  coverColor: string;
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
    tool_choice: toolChoiceFor(options.model, TOOL_NAME),
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
    kind?: "reaction" | "game";
    gameName?: string;
    coverWords?: string;
    coverColor?: string;
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
    kind: input.kind === "reaction" ? "reaction" : "game",
    gameName: input.gameName?.trim() ? input.gameName.trim() : null,
    coverWords: input.coverWords?.trim() ? input.coverWords.trim().toUpperCase() : null,
    coverColor: input.coverColor ?? "giallo",
  };
}
