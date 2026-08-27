import type { TranscriptSegment, ClipCandidateWindow, RankedClip } from "@clipforge/shared";
import { rankedClipsResponseSchema, TEMPLATE_NAMES, EDITING_STYLES, CLIP_BADGES } from "@clipforge/shared";
import { getAnthropicClient } from "./anthropic-client.js";
import { formatSegments, segmentsInWindow } from "./transcript-formatting.js";
import { extractCandidateFrameJpegs } from "./frame-sampler.js";
import { logger } from "../../lib/logger.js";
import type Anthropic from "@anthropic-ai/sdk";

const FRAMES_PER_CANDIDATE = 3;

const TOOL_NAME = "return_ranked_clips";

const EDL_EVENT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        time: { type: "number" },
        action: { type: "string", enum: ["zoom"] },
        scale: { type: "number", description: "1.0-2.0, es. 1.1 per un leggero zoom-in" },
      },
      required: ["time", "action", "scale"],
    },
    {
      type: "object",
      properties: {
        time: { type: "number" },
        action: { type: "string", enum: ["punch_in"] },
        scale: { type: "number" },
      },
      required: ["time", "action", "scale"],
    },
    {
      type: "object",
      properties: {
        time: { type: "number" },
        action: { type: "string", enum: ["highlight_word"] },
        word: { type: "string" },
      },
      required: ["time", "action", "word"],
    },
    {
      type: "object",
      properties: {
        time: { type: "number" },
        action: { type: "string", enum: ["speaker_switch"] },
        speaker: { type: "string" },
      },
      required: ["time", "action", "speaker"],
    },
  ],
};

const RANKING_TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: "Restituisce le clip finali selezionate, con punteggi ed Edit Decision List (EDL).",
  input_schema: {
    type: "object" as const,
    properties: {
      clips: {
        type: "array",
        maxItems: 30,
        items: {
          type: "object",
          properties: {
            start: { type: "number" },
            end: { type: "number" },
            duration: { type: "number" },
            hook: { type: "string" },
            title: {
              type: "string",
              description:
                "Titolo REALE di pubblicazione su YouTube Shorts, max ~80 caratteri — segui alla lettera la sezione 'Stile titoli' del prompt di sistema (maiuscolo su hook, punteggiatura doppia, vocali accentate con apostrofo, emoji coerenti, tono esagerato), non un titolo 'corretto'.",
            },
            reason: { type: "string", description: "Perché questa clip funziona, in 1-2 frasi." },
            scores: {
              type: "object",
              properties: {
                hook: { type: "integer", minimum: 0, maximum: 100 },
                retention: { type: "integer", minimum: 0, maximum: 100 },
                emotion: { type: "integer", minimum: 0, maximum: 100 },
                clarity: { type: "integer", minimum: 0, maximum: 100 },
                payoff: { type: "integer", minimum: 0, maximum: 100 },
                virality: { type: "integer", minimum: 0, maximum: 100 },
              },
              required: ["hook", "retention", "emotion", "clarity", "payoff", "virality"],
            },
            editing_style: { type: "string", enum: [...EDITING_STYLES] },
            edl: {
              type: "object",
              properties: {
                template: { type: "string", enum: [...TEMPLATE_NAMES] },
                events: { type: "array", maxItems: 40, items: EDL_EVENT_SCHEMA },
              },
              required: ["template", "events"],
            },
            hashtags: {
              type: "array",
              maxItems: 10,
              items: { type: "string" },
              description: "5-8 hashtag pertinenti per la pubblicazione su YouTube Shorts, SENZA il simbolo #, in minuscolo, senza spazi (es. \"podcast\", \"funnymoments\").",
            },
            caption: {
              type: "string",
              description:
                "Didascalia pronta per la pubblicazione (YouTube Shorts/TikTok), da mostrare al pubblico. 1-2 frasi brevi, in italiano colloquiale/slang naturale (quello che si usa davvero nei titoli/descrizioni di Shorts), DIVERTENTE o ad effetto, MAI cringe o forzata. NON deve spiegare o analizzare la clip (quello è il campo 'reason', che resta interno) — deve essere il testo che leggerebbe un utente reale sotto il video, tipo hook/teaser, non un riassunto.",
            },
            badges: {
              type: "array",
              maxItems: 5,
              items: { type: "string", enum: [...CLIP_BADGES] },
              description:
                "Pattern virali riconosciuti in QUESTA clip specifica, tra quelli elencati nel prompt di sistema. Array vuoto se non ne riconosci nessuno — è normale e non penalizza la clip: i badge sono un segnale IN PIÙ mostrato in dashboard, mai un motivo per scartare o abbassare i punteggi.",
            },
          },
          required: [
            "start",
            "end",
            "duration",
            "hook",
            "title",
            "reason",
            "scores",
            "editing_style",
            "edl",
            "hashtags",
            "caption",
            "badges",
          ],
        },
      },
    },
    required: ["clips"],
  },
};

const SYSTEM_PROMPT = `Sei un editor esperto di YouTube Shorts, ESIGENTE: il primo passaggio (economico) ha già scremato molto, ma tende comunque a lasciar passare momenti "energici ma vuoti" — rumorosi o pieni di parolacce senza un vero payoff comico/narrativo dietro. Il tuo lavoro è il controllo qualità finale. Ricevi una lista di finestre candidate con il transcript di contesto e, per ognuna, alcuni frame campionati dal video — usali per giudicare anche ciò che il testo non cattura (espressioni, reazioni, energia visiva, cosa sta succedendo a schermo), non solo le parole. Per ogni candidato devi:

1. Scartare senza pietà i candidati deboli: poco hook, poco comprensibili da soli, ripetitivi, o semplicemente "rumorosi" (esclamazioni/parolacce) senza una battuta, una svolta o un fatto concreto dietro. Meglio restituire 2 clip forti che 6 mediocri — non riempire la lista per riempirla.
2. Per ognuno dei rimanenti, assegnare 6 punteggi da 0 a 100 (hook, retention, emotion, clarity, payoff, virality) usando l'INTERA scala in modo calibrato, non ammassata in una fascia stretta:
   - 90-100: eccezionale, tra i migliori momenti possibili per quel tipo di contenuto — riservalo a ciò che è realmente il top, non usarlo come default per "molto buono".
   - 75-89: forte, chiaramente sopra la media, funzionerebbe bene come Short.
   - 55-74: discreto, ha potenziale ma non è memorabile.
   - Sotto 55: debole — se un candidato scende sistematicamente sotto 50 su più dimensioni, scartalo invece di includerlo con punteggi bassi.
   Differenzia davvero il candidato migliore dagli altri: se 5 clip diverse meritano tutte "80" su ogni dimensione, non stai valutando abbastanza a fondo — quasi sempre alcune si distinguono nettamente dalle altre.
3. Scrivere un titolo (vedi "Stile titoli" sotto) e il motivo (reason) per cui la clip funziona — reason è un campo INTERNO, mostrato solo nella dashboard per capire la scelta, non finisce mai pubblicato.
4. Scegliere un editing_style (dynamic, clean, high_energy, calm) e un template coerente tra PODCAST_DYNAMIC, PODCAST_CLEAN, STREAMER, STORYTELLING, MOTIVATIONAL.
5. Generare una Edit Decision List (EDL) con eventi "zoom" (sui momenti di enfasi), "highlight_word" (sulle 2-5 parole chiave più importanti della clip), "speaker_switch" (se cambia chi parla) e opzionalmente "punch_in" su un climax. I timestamp degli eventi devono cadere DENTRO l'intervallo [start, end] della clip e sono relativi al video originale (stessa timeline del transcript), non relativi all'inizio della clip.
6. Generare 5-8 hashtag pertinenti per la pubblicazione su YouTube Shorts (senza #, minuscolo, senza spazi: es. "podcast", "funnymoments", non "Funny Moments"). Mescola hashtag generici ad alto volume di ricerca (es. "shorts", "viral") con 2-3 specifici al contenuto della clip.
7. Scrivere una caption pubblica: 1-2 frasi brevi in italiano colloquiale/slang naturale (il linguaggio vero usato nei titoli/descrizioni di Shorts/TikTok italiani), divertente o ad effetto, MAI cringe, MAI un riassunto o una spiegazione — è il testo che un utente reale legge sotto il video, non l'analisi della clip.
8. Assegnare (opzionalmente) uno o più badge tra: "gotcha" (un'affermazione viene fatta e poi smentita/corretta in diretta — es. "a volte le aragoste perdono le zampe da sole" seguito da "questa l'hai inventata"/"gliele hai staccate tu": funziona perché crea un momento di giudizio/rivincita, non solo un fatto curioso), "cliffhanger" (la clip si chiude su una domanda aperta o una svolta non risolta), "controversial" (un'opinione netta e divisiva, il tipo di cosa che genera commenti "vero"/"falso"), "relatable" (una situazione/dolore quotidiano riconoscibile, non un fatto astratto), "high_energy" (reazione fisica/vocale molto marcata, non solo parlato normale). Un candidato può avere zero badge: è normale, NON è un difetto e non deve influenzare i punteggi al ribasso — i badge sono un segnale aggiuntivo per la dashboard, mai un filtro. Non forzare un badge se non calza davvero: meglio nessun badge che uno finto.

Calibrazione: non premiare automaticamente contenuto "corretto ma piatto" (spiegazioni fluide, tono pacato, fatti ordinati) solo perché è ben espresso — su questo formato vince quasi sempre il momento di attrito reale (un gotcha, una reazione fisica forte, un'opinione netta), non la clip più "educata". Se stai esitando tra una clip pulita ma poco mordente e una più caotica/diretta che genera davvero una reazione, preferisci la seconda.

Stile titoli (campo "title", è il titolo REALE con cui il video viene pubblicato su YouTube, non una didascalia): scrivi come scrivono davvero i canali italiani di reaction/streaming di successo, non come un editor "corretto". Pattern osservati su titoli reali ad alto engagement, replicali:
- MAIUSCOLO sulle parole chiave/sul hook (non serve tutto il titolo in caps, ma quasi sempre la parte "urlata" lo è).
- Punteggiatura aggressiva e spesso doppia: "?!", "!!", "..", "..?!" — non fermarti al singolo "?" o "." se il tono è esagerato.
- Le vocali accentate maiuscole si scrivono con l'apostrofo, non con l'accento: "PIU'" non "PIÙ", "E'" non "È", "PERCHE'" non "PERCHÉ" — è la convenzione reale usata su YouTube Shorts italiani, non un errore da correggere.
- Ellissi "..." per sospendere prima di una parola/frase a sorpresa, eventualmente con ":" in stile setup→punchline (es. "Lollo e la sua amica:…dislessia").
- Se la clip si presta, usa il formato "POV:" o un rating tipo "da 1 a 10".
- Includi il nome delle persone coinvolte quando è naturale dal contesto, spesso in caps.
- Chiudi (opzionale) con 1-2 emoji coerenti col tono, mai decorativi a caso: 💀🥶 per shock/assurdo, 🤬 per rabbia, 🇮🇹 per un riferimento nazionale, ecc. Mai più di 2-3 emoji.
- Tono assurdo/esagerato/controverso, mai educato, pacato o esplicativo — evita titoli che "riassumono" la clip.
- NON aggiungere hashtag nel titolo (a differenza di alcuni esempi reali) — nella nostra pipeline vivono nel campo "hashtags" a parte, altrimenti si duplicano.
- Max ~80 caratteri.

Esempi reali (solo per stile/registro, non copiarli — i contenuti sono diversi):
"POV: COME SI SVEGLIANO LE PERSONE?!🗿🥱"
"NON SMETTE FINO A QUANDO NON SI ARRABBIA!!🫪"
"NINNA e MATTI cosa COMBINATE..?!"
"L'INFLUENCER PIU' ODIATO D'ITALIA?!🇮🇹🤬"
"LA SFIDA RAP PIU' BELLA DI SEMPRE!!😂😱"
"PRIMO BAGNO dell'ANNO FINITO MALE.."
"QUANTO E' PAZZA DA 1 A 10?!💀🥶"
"Lollo e la sua amica:…dislessia 😜😂"

Usa ESCLUSIVAMENTE i timestamp presenti nel transcript fornito. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

export interface RankingOptions {
  apiKey: string;
  model: string;
  videoTitle: string;
  /** Video sorgente locale, usato per estrarre i frame mostrati all'AI insieme al transcript. */
  sourceVideoPath: string;
}

export async function rankAndBuildEdl(
  candidates: ClipCandidateWindow[],
  segments: TranscriptSegment[],
  options: RankingOptions,
): Promise<RankedClip[]> {
  if (candidates.length === 0) return [];

  const client = getAnthropicClient(options.apiKey);
  const userContent = await buildUserContent(candidates, segments, options.videoTitle, options.sourceVideoPath);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userContent }];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const message = await client.messages.create({
      model: options.model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages,
      tools: [RANKING_TOOL_SCHEMA],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });

    const toolUseBlock = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME,
    );

    if (!toolUseBlock) {
      logger.warn("Nessun output strutturato dal passaggio di ranking", { attempt });
      continue;
    }

    const validation = rankedClipsResponseSchema.safeParse(toolUseBlock.input);
    if (validation.success) {
      return validation.data.clips as RankedClip[];
    }

    logger.warn("Output di ranking non valido, tentativo di correzione", { attempt, issues: validation.error.issues });

    // Un messaggio assistant con un blocco tool_use DEVE essere seguito da un tool_result
    // (con lo stesso tool_use_id) nel messaggio successivo, non da testo libero — altrimenti
    // l'API Anthropic rifiuta la richiesta successiva con un 400.
    messages.push({ role: "assistant", content: message.content });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          is_error: true,
          content: `Il tuo output precedente non rispetta lo schema richiesto. Errori: ${validation.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}. Richiama lo strumento ${TOOL_NAME} con un input corretto.`,
        },
      ],
    });
  }

  throw new Error("Il passaggio di ranking AI non ha prodotto un output valido dopo 2 tentativi");
}

async function buildUserContent(
  candidates: ClipCandidateWindow[],
  segments: TranscriptSegment[],
  videoTitle: string,
  sourceVideoPath: string,
): Promise<Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>> {
  const CONTEXT_PADDING_SECONDS = 20;

  const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [
    { type: "text", text: `Video: "${videoTitle}"` },
  ];

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    const contextSegments = segmentsInWindow(
      segments,
      Math.max(0, candidate.start - CONTEXT_PADDING_SECONDS),
      candidate.end + CONTEXT_PADDING_SECONDS,
    );

    content.push({
      type: "text",
      text: `### Candidato ${index + 1}
Hook individuato: ${candidate.hook}
Motivo (dal primo passaggio): ${candidate.reason}
Transcript con contesto (${(candidate.start - CONTEXT_PADDING_SECONDS).toFixed(0)}s - ${(candidate.end + CONTEXT_PADDING_SECONDS).toFixed(0)}s):
${formatSegments(contextSegments)}`,
    });

    let frames: string[] = [];
    try {
      frames = await extractCandidateFrameJpegs(sourceVideoPath, candidate.start, candidate.end, FRAMES_PER_CANDIDATE);
    } catch (err) {
      logger.warn("Estrazione frame per il ranking fallita per un candidato, procedo senza immagini per questo", {
        candidateIndex: index,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (frames.length > 0) {
      content.push({ type: "text", text: `Frame del candidato ${index + 1}:` });
      for (const frame of frames) {
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame } });
      }
    }
  }

  return content;
}
