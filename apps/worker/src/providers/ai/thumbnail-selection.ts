import { getAnthropicClient, toolChoiceFor, logAnthropicCost } from "./anthropic-client.js";
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
      reactedFormat: {
        type: "string",
        enum: ["tiktok", "video", "altro"],
        description: "Solo per reaction: tiktok = reagiscono a TikTok/Reels/Shorts verticali (uno o tanti); video = a un video lungo orizzontale; altro = il resto.",
      },
      contentFrames: {
        type: "array",
        items: {
          type: "object",
          properties: { index: { type: "integer" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        },
        description: "Solo per reaction a TikTok: fino a 3 fotogrammi (indici diversi) dove si vede BENE il TikTok a cui reagiscono, con la faccia o il soggetto del TikTok: per ognuno il riquadro (frazioni 0-1) che contiene SOLO il TikTok verticale, senza webcam, chat o interfaccia. Scegli quelli coi soggetti più espressivi o assurdi.",
      },
      otherGames: {
        type: "array",
        items: { type: "string" },
        description: "Solo per game con PIÙ giochi (tornei, serate a più giochi): gli ALTRI giochi oltre a gameName, nome esatto, dai fotogrammi e dal titolo. Vuoto se è un gioco solo.",
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
      inspirationIndex: {
        type: "integer",
        description: "Solo se ti ho dato le COPERTINE CHE FUNZIONANO: il numero di quella da prendere come modello per scena e composizione (la più adatta a QUESTO video), 0 se nessuna va bene.",
      },
      sceneIdea: {
        type: "string",
        description: "IN INGLESE, 1-2 frasi concrete per il grafico: cosa fanno gli streamer in copertina, cosa c'è dietro, oggetti o costumi a tema, ispirandoti alla copertina modello ma adattata a QUESTO video. Mai nomi di persone vere diverse dagli streamer, mai parole come truffa/scam.",
      },
      layout: {
        type: "string",
        enum: ["lati", "fila", "tabellone", "gioco"],
        description:
          "Impaginazione, la più adatta a QUESTO video (varia, non sempre la stessa): lati = 2-3 streamer enormi ai lati e al centro un ELEMENTO gigante e buffo del video; fila = 3-4 streamer in fila, vestiti tutti a tema (operai, calciatori...), dietro il mondo del gioco; tabellone = dietro l'interfaccia del gioco/quiz ricreata grande (tabellone di Jeopardy, carte del bingo, griglia di un quiz) e gli streamer davanti; gioco = il mondo del gioco grande al centro e gli streamer in primo piano ai lati.",
      },
      heroElement: {
        type: "string",
        description: "IN INGLESE: l'elemento centrale gigante e buffo che riassume il video (es. 'a lion wearing a football jersey', 'a giant blue tarantula', 'Bigfoot roaring'); vuoto se non serve.",
      },
      textStyle: {
        type: "string",
        description:
          "IN INGLESE: come disegnare la scritta, A TEMA col video o col gioco e diversa ogni volta: font, colori delle due righe, effetti. Es. horror: 'dripping blood-red horror font with scratches'; un gioco: 'the game's own logo font and colors (e.g. EA FC neon green)'; Dragon Ball: 'Dragon Ball style flaming orange 3D letters'; un quiz: 'glossy TV quiz show yellow and blue letters'; un film: 'serif movie-title font'. Sempre grande, leggibilissima, con contorno spesso.",
      },
    },
    required: ["backgroundFrameIndex", "kind", "coverColor"],
  },
};

const SYSTEM_PROMPT = `Sei un editor esperto di copertine YouTube per video reaction/gameplay. Ti vengono mostrati alcuni fotogrammi campionati da un video già montato, numerati da 0 in ordine. Guardali e:

1. Scegli l'indice del fotogramma migliore da usare come SFONDO della copertina — MAI uno con interfaccia browser/player visibile (barra di avanzamento, controlli, sidebar chat, testo di commenti): se capita in tutti, scegli quello con meno interfaccia e ritagliala via con contentCropBox.
2. Se riesci a leggere con sicurezza il titolo o il canale del video/contenuto che si sta reagendo in uno dei fotogrammi, scrivilo in reactedVideoQuery.
3. Scegli l'espressione delle facce più adatta al tono (desiredExpression).
4. Dì se è una reaction o un gioco (kind); per una reaction dì a cosa reagiscono (reactedFormat) e, se sono TikTok, scegli i fotogrammi dove si vedono (contentFrames); per un gioco scrivi il nome esatto del gioco (gameName) e, se nel video si gioca a più giochi (tornei, serate), gli altri in otherGames.
5. Scrivi SEMPRE la SCRITTA della copertina (coverWords) e il colore (coverColor): per un gioco cosa succede nella partita, per una reaction o uno Short la battuta o la cosa assurda di cui si parla.

OGNI COPERTINA DEVE ESSERE DIVERSA (simo: le nostre sembrano "ripetitive, schematizzate"): come il canale AuraBooter, che per BIGFOOT usa un font horror rosso che cola, per PROCLUB il verde di EA FC, per QUIPLASH il font del gioco, per una reaction a Dragon Ball lettere infuocate stile Dragon Ball. Scegli layout, heroElement e textStyle a tema con QUESTO video.

Regole della SCRITTA: 1-3 parole in italiano, come le scrivono i canali di clip italiani su Blur, Marza e Pesh. Esempi VERI che funzionano (i primi tre sono del canale preferito del proprietario): "HO DOPPIATO HARRY POTTER", "SERATA SPORTIVA", "DOPPIAGGIO DROGHEGGIANTE", "MEGA JEOPARDY", "GIOCHI BRUTTI", "SIAMO DOPPIATORI", "TELEFONATAAA", "DISTRUTTI A GOLF", "LA RUN PERFETTA?", "COME HA FATTO??", "MEGA POKERATA", "JEOPARDY CHEATER?!", "TORNEO TUTTI CONTRO TUTTI", "DIVENTIAMO MURATORI", "SONO GAY?", "ERA UN'IA?!", "BARBA INCOLLATA".
- Dice cosa succede o la battuta del video, con parole da ragazzi: niente "INCREDIBILE", "EPICO", "PAZZESCO", "SFIDA ESTREMA", "IMPERDIBILE", niente frasi da pubblicità o da giornale.
- Si può usare il nome del gioco se è corto e riconoscibile (MEGA JEOPARDY), punti di domanda o esclamativi alla fine, lettere allungate (TELEFONATAAA).
- Niente emoji, niente nomi degli streamer (le loro facce sono già in copertina).

Se ti do le COPERTINE CHE FUNZIONANO (copertine vere dei canali che il proprietario segue, con quante visualizzazioni hanno fatto rispetto al solito del loro canale): sono il tuo allenamento. Guarda cosa hanno in comune quelle che fanno molte più visualizzazioni del solito (che tipo di parole, quante, punteggiatura, che scena) e fai lo stesso per questo video. La scritta deve parlare di QUESTO video: MAI prendere le parole di quelle copertine (se il video ha un nome suo, es. un torneo col suo nome, usa quello). Scegli la più adatta come modello (inspirationIndex) e scrivi sceneIdea.

Rispondi chiamando lo strumento ${TOOL_NAME}.`;

export interface ThumbnailSelectionOptions {
  apiKey: string;
  model: string;
  clipTitle: string;
  clipHook: string;
  clipCaption: string;
  /** Fotogrammi JPEG in base64, nello stesso ordine con cui vengono numerati nel prompt. */
  frameJpegsBase64: string[];
  /** Istruzioni scritte da simo nel sito (gioco, scritte, stile): hanno la precedenza. */
  userInstructions?: string;
  /** Copertine dei canali seguiti che hanno funzionato (describeInspiration in lib/cover-inspo.ts). */
  inspiration?: string;
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
  otherGames: string[];
  reactedFormat: "tiktok" | "video" | "altro" | null;
  /** Fotogrammi dei TikTok a cui reagiscono, col riquadro del solo TikTok (frazioni 0-1). */
  contentFrames: Array<{ index: number; x: number; y: number; width: number; height: number }>;
  layout: "lati" | "fila" | "tabellone" | "gioco" | null;
  heroElement: string | null;
  textStyle: string | null;
  /** 1-based fra le copertine passate in inspiration; null = nessuna. */
  inspirationIndex: number | null;
  sceneIdea: string | null;
}

export async function selectThumbnailAssets(options: ThumbnailSelectionOptions): Promise<ThumbnailSelection> {
  const client = getAnthropicClient(options.apiKey);

  const content: Anthropic.MessageParam["content"] = [
    {
      type: "text",
      text: `Video: "${options.clipTitle}"\nRiassunto: ${options.clipHook}\nDescrizione: ${options.clipCaption}${
        options.inspiration ? `\n\nCOPERTINE CHE FUNZIONANO (dai canali seguiti, le più vicine a questo video):\n${options.inspiration}` : ""
      }${
        options.userInstructions ? `\n\nISTRUZIONI DEL PROPRIETARIO DEL CANALE (hanno la precedenza su tutto, anche sul gioco e sulla scritta): ${options.userInstructions}` : ""
      }`,
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
  logAnthropicCost("scelta copertina", options.model, message.usage);

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
    inspirationIndex?: number;
    sceneIdea?: string;
    otherGames?: string[];
    layout?: string;
    heroElement?: string;
    textStyle?: string;
    reactedFormat?: string;
    contentFrames?: Array<{ index?: number; x?: number; y?: number; width?: number; height?: number }>;
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
    layout: input.layout === "lati" || input.layout === "fila" || input.layout === "tabellone" || input.layout === "gioco" ? input.layout : null,
    heroElement: input.heroElement?.trim() || null,
    textStyle: input.textStyle?.trim() || null,
    reactedFormat: input.reactedFormat === "tiktok" || input.reactedFormat === "video" || input.reactedFormat === "altro" ? input.reactedFormat : null,
    contentFrames: (Array.isArray(input.contentFrames) ? input.contentFrames : [])
      .filter((c) => typeof c.index === "number" && c.index >= 0 && c.index < options.frameJpegsBase64.length)
      .map((c) => ({ index: c.index!, x: clamp01(c.x ?? 0), y: clamp01(c.y ?? 0), width: clamp01(c.width ?? 1), height: clamp01(c.height ?? 1) }))
      .filter((c, i, all) => c.width > 0.05 && c.height > 0.1 && all.findIndex((o) => o.index === c.index) === i)
      .slice(0, 3),
    otherGames: Array.isArray(input.otherGames) ? input.otherGames.map((g) => String(g).trim()).filter(Boolean).slice(0, 5) : [],
    inspirationIndex: typeof input.inspirationIndex === "number" && input.inspirationIndex > 0 ? input.inspirationIndex : null,
    sceneIdea: input.sceneIdea?.trim() ? input.sceneIdea.trim() : null,
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
