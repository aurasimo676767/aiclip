import type { TranscriptSegment, ClipCandidateWindow, RankedClip } from "@clipforge/shared";
import { rankedClipsResponseSchema, TEMPLATE_NAMES, EDITING_STYLES, CLIP_BADGES, CLIP_DURATION_TARGET } from "@clipforge/shared";
import { getAnthropicClient, cachedSystemPrompt, logAnthropicCost } from "./anthropic-client.js";
import { formatSegments, segmentsInWindow } from "./transcript-formatting.js";
import { extractCandidateFrameJpegs } from "./frame-sampler.js";
import { buildPerformanceFeedback } from "./performance-feedback.js";
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
            start: {
              type: "number",
              description:
                "Timestamp di inizio: puoi e DEVI spostarlo rispetto al candidato ricevuto se questo include ancora setup/preambolo prima della vera frase-gancio — usa il transcript con contesto per trovare il punto esatto in cui inizia il contenuto forte, non l'introduzione che ci porta. Le prime parole della clip da questo punto devono essere già il succo.",
            },
            end: {
              type: "number",
              description: `Timestamp di fine — end - start non deve MAI superare ${CLIP_DURATION_TARGET.hardMax}s. Se il payoff naturale del momento richiede più tempo, taglia più aggressivamente (accorcia il finale o rimuovi rilanci/ripetizioni) invece di sforare.`,
            },
            duration: { type: "number", description: `In secondi, deve coincidere con end - start e non superare ${CLIP_DURATION_TARGET.hardMax}.` },
            hook: { type: "string", description: "Le PRIME parole esatte con cui la clip si apre (non un riassunto) — devono già essere il contenuto forte." },
            title: {
              type: "string",
              description:
                "Titolo REALE di pubblicazione su YouTube Shorts: CORTO (4-7 parole, massimo ~40 caratteri) — segui alla lettera la sezione 'Stile titoli' del prompt di sistema: la frase detta nella clip tra virgolette, oppure stile Lollo (maiuscolo tranne le parole piccole, UN solo segno finale '..' o '?!' o '!!', 0-2 emoji). Niente spiegazioni in coda.",
            },
            reason: { type: "string", description: "Perché questa clip funziona, in 1-2 frasi." },
            whyStop: {
              type: "string",
              description:
                "In UNA frase concreta: perché uno sconosciuto che scorre gli Shorts si ferma e magari commenta (cosa esattamente lo fa ridere, stupire, arrabbiare o discutere). Se non riesci a scriverlo in modo concreto, NON restituire questa clip.",
            },
            headline: {
              type: "string",
              description:
                "Titolo fisso che sta in alto sullo Short per tutta la durata. CORTO: 2-5 parole, massimo 25 caratteri, scritto come lo scriverebbe un ragazzo che gestisce un canale di clip, NON come un titolo da AI o da giornale. Dice subito di cosa si parla. Può finire con UNA emoji che c'entra (😭 💀 🤬 😱 🤣 🔥). Esempi veri: \"CUCINA UN POKEMON?! 💀\", \"CI HANNO DERUBATO 🤬\", \"SONO GAY?\", \"HA MANGIATO I RAGNI 🤢\", \"NON SA IL TESTO 😭\". Vietato: INCREDIBILE, PAZZESCO, EPICO, ASSURDO come parola da sola, frasi lunghe, nomi degli streamer.",
            },
            streamerReacts: {
              type: "boolean",
              description:
                "true se lo streamer parla o reagisce in modo sentito per buona parte della clip (commenta, ride, si arrabbia, risponde). false se si sente quasi solo il video/TikTok reagito e lo streamer sta zitto o dice due parole.",
            },
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
                "Descrizione pubblica sotto lo Short (YouTube e TikTok). Come la scrivono i canali di clip veri: una frasetta CORTISSIMA (2-8 parole), tutta minuscola, senza punto finale, come un commento di un amico — es. \"a peshò gasi\", \"beh gianmò fair enough direi\", \"siamo finiti\", \"ma chi cucina pikachu\". Al massimo UNA emoji, spesso nessuna. Vietato: riassumere o spiegare la clip, frasi da AI (\"guarda che reazione\", \"ha perso la testa\", \"non se n'è pentito\"), maiuscole a caso. Se non ti viene niente di naturale, lascia la stringa vuota: gli hashtag si aggiungono da soli.",
            },
            reactedContentStart: {
              type: "number",
              description:
                "SOLO se la clip è una reaction a un TikTok, un video o una clip di altri: il secondo (stessa timeline di start) in cui PARTE il contenuto reagito, cioè quando si comincia a sentire il TikTok/video (voci diverse, musica) o lo si vede partire nei fotogrammi. Ometti se non è una reaction.",
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
            "whyStop",
            "streamerReacts",
            "headline",
            "badges",
          ],
        },
      },
    },
    required: ["clips"],
  },
};

const SYSTEM_PROMPT = `Sei un editor esperto di YouTube Shorts, ESIGENTE: il primo passaggio (economico) ha già scremato molto, ma tende comunque a lasciar passare momenti "energici ma vuoti" — rumorosi o pieni di parolacce senza un vero payoff comico/narrativo dietro. Il tuo lavoro è il controllo qualità finale. Ricevi una lista di finestre candidate con il transcript di contesto e, per ognuna, alcuni frame campionati dal video — usali per giudicare anche ciò che il testo non cattura (espressioni, reazioni, energia visiva, cosa sta succedendo a schermo), non solo le parole. Per ogni candidato devi:

1. Scartare senza pietà i candidati deboli: poco hook, poco comprensibili da soli, ripetitivi, o semplicemente "rumorosi" (esclamazioni/parolacce) senza una battuta, una svolta o un fatto concreto dietro. Presta attenzione in particolare al "botta e risposta circolare": due persone che si scambiano domande/reazioni confuse ("che significa?" "boh" "cioè?" "dio") SENZA che nessuna delle due arrivi mai a una risposta, un fatto o una svolta concreta — non è "clarity" solo perché le battute si capiscono singolarmente, è un giro a vuoto e va scartato o comunque penalizzato pesantemente su payoff e clarity, anche se l'energia/reazione fisica è alta (quella al massimo giustifica "high_energy" come badge, non un punteggio alto). Un vero botta e risposta forte HA una progressione (qualcuno spiega, sbaglia, viene corretto, arriva a una battuta) — se rileggendo il transcript la conversazione potrebbe continuare all'infinito senza cambiare nulla, è debole. Meglio restituire 2 clip forti che 6 mediocri — non riempire la lista per riempirla.
2. Rifinire start/end di ogni candidato superstite PRIMA di assegnare i punteggi: il passaggio precedente (economico) individua la finestra giusta ma può sbagliare il punto esatto. Usa il transcript con contesto (hai ~20s in più prima e dopo il candidato) per verificare che "start" cada ESATTAMENTE sulla prima parola della frase-gancio, non su un preambolo/setup che la precede ("allora ragazzi", "quindi vi dicevo", introduzioni, pause morte) — sposta start in avanti se serve, anche se il candidato originale iniziava prima. Le prime parole della clip risultante devono già essere il contenuto forte: un'affermazione controintuitiva, un fatto/numero sorprendente, o l'attacco di una reazione emotiva forte.
   ATTENZIONE su "end" (errore osservato in produzione: molte clip finivano subito dopo il gancio, 10-15s totali, senza spazio per lo sviluppo — risultato piatto, non divertente): "end" NON deve fermarsi appena finisce la frase-gancio. Deve includere il payoff che segue — la reazione, la battuta, l'escalation, la spiegazione assurda — e chiudersi quando la storia è finita, non al primo punto utile. LA DURATA LA DECIDE LA STORIA: una battuta secca sta in 20-30 s, una storia o una reaction con setup, sviluppo e finale di solito sta sotto ${CLIP_DURATION_TARGET.max} s; fino a ${CLIP_DURATION_TARGET.hardMax} s SOLO se è forte dall'inizio alla fine. Non allungare MAI con chiacchiere, rilanci o tempi morti per arrivare a una durata: uno Short da 25 s tutto pieno batte uno da 55 s con 20 s di vuoto. Poi imponi il tetto di durata: end - start non deve MAI superare ${CLIP_DURATION_TARGET.hardMax} secondi — se il payoff naturale è più lungo, accorcia il finale o taglia rilanci/ripetizioni invece di sforare, ma preferisci sempre tenere il payoff piuttosto che tagliarlo per stare più corti del necessario: il tetto è un MASSIMO, non un obiettivo da raggiungere il prima possibile.
2-quinquies. SOLO SHORTS CHE VALE LA PENA PUBBLICARE (simo, 2026-09-27: "fa short anche inutili, di roba che non fa divertire né nulla"). Uno Short deve far ridere, stupire, arrabbiare o far discutere chi non conosce lo streamer: se il momento è solo "interessante", informativo senza una reazione forte, o una chiacchierata tranquilla, SCARTALO anche se il resto è ben fatto.
   LO STREAMER DEVE REAGIRE: il valore di un canale di clip è la reazione dello streamer. Uno Short in cui si sente quasi solo il video/TikTok reagito e lo streamer non parla o dice due parole è contenuto di altri ripubblicato: va scartato (streamerReacts=false), anche se il video reagito è forte. YouTube inoltre limita la diffusione dei contenuti riusati senza commento.
   Esempi VERI di Shorts inutili usciti prima, da non rifare: "STA FOTO E' DI UNA BARA PROFANATA VERA..?!" (curiosità raccontata, nessuna reazione forte), "LOLLO SBOTTA CONTRO CHI LO SEGUE..?!" (lamentela senza battuta né finale), "HA FUMATO PER 20 ANNI OGNI GIORNO.. ECCO PERCHE' CORRE ORA" (lo streamer non parla per tutto lo Short, si sente solo il video).
   Meglio 2 Shorts da pubblicare subito che 8 mediocri.
2-septies. NIENTE SESSO E PAROLACCE NEL TESTO PUBBLICATO (dati reali del canale, 2026-09-30): con parole volgari, sessuali o bestemmie nel titolo, nella caption o nella headline YouTube non mette lo Short nel feed: 2-150 views invece di ~1.200. Anche scritte con numeri o asterischi le riconosce: "C3SSO" 6 views, "SC0P4ARE il C2L0" 2, "B***HINO" 19, "Che cazzo è il latte crudo?" 3, "tette grosse" 25, "si sale da dietro" 9, "PORCO DI" 148. Quindi in title, caption e headline: niente cazzo/minchia/merda e simili, niente riferimenti sessuali (nemmeno doppi sensi), niente bestemmie neanche a metà, niente "cancro", "stupro", "suicidio". L'audio della clip può avere parolacce, il testo no: descrivi la situazione in modo pulito ma esagerato ("HA DETTO COSA AL FUNERALE?! 💀"). Se il momento vive SOLO di sesso o volgarità e un titolo pulito non lo racconta, scarta il candidato.
2-sexies. IL FINALE (per le ri-visualizzazioni): "end" cade subito dopo la battuta, la reazione o la rivelazione più forte, senza code ("vabbè", "comunque", risate che si spengono, cambi di discorso): lo Short deve finire di colpo e ripartire, così chi guarda lo riguarda.
   BONUS, raro (circa una volta su cento): se qualcuno sta RACCONTANDO una storia e c'è un punto di fine in cui l'ultima frase si attacca in modo naturale alla prima (una domanda, un "e lui mi fa...", una frase che l'inizio completa), scegli quel punto: lo Short va in loop e non si capisce dove finisce. Mai forzarlo: se non c'è in modo naturale, chiudi sulla battuta.
2-quater. CONTESTO SUBITO DOPO IL GANCIO (simo, 2026-09-27: "ci deve essere sempre un hook forte, e sopratutto contesto"): prima la frase forte, poi nelle frasi immediatamente successive chi guarda deve capire di cosa si parla (chi, cosa, perché è assurdo). Se il contesto utile viene PRIMA del gancio e senza non si capisce niente, tienilo solo se è anch'esso un gancio (una domanda, un'affermazione forte); altrimenti scegli un altro candidato. Uno Short che dopo 5 secondi non si capisce ancora di cosa parla va scartato.
2-ter. I PRIMI 2 SECONDI (regola di chi pubblica gli Shorts): chi scorre decide in 2 secondi se restare. La prima frase della clip, quella da cui parte "start", deve dare un MOTIVO per restare e magari commentare: una domanda (anche stupida), un'affermazione forte o assurda, un'esclamazione, un insulto, un'informazione che incuriosisce. Il codice poi mette da solo mezzo secondo di respiro prima della prima parola: tu metti "start" esattamente sulla prima parola di quella frase e scrivi in "hook" le sue prime parole ESATTE come nel transcript.
   Aperture da NON usare (prese da Shorts veri che partivano male): balbettii e parole ripetute ("Io Io te lo giuro", "tu tu sei innamorato no no però", "Ma Ma scusami"), frasi che senza il contesto prima non si capiscono ("se non è che è Dunkirk che prendi il cancro", "E c'era statizia"), riempitivi ("allora", "comunque", "e niente", "eh ragazzi"). Se la frase forte arriva dopo 2-3 secondi di chiacchiere, parti dalla frase forte; se il balbettio è dentro la frase forte, parti dalla parola dopo il balbettio.
   Aperture che funzionano: "Ci hanno derubato stanotte", "Marzò mi faresti un po' di telecronaca?", "Minchia il prime di Capoplaza", "Indovinate cosa c'è per il vincitore", "Quale artista è diventata famosa grazie al brano Vendo?".
   REACTION a un TikTok, a un video o a una clip: la clip deve partire PRIMA del contenuto reagito, dal suo inizio (o dalla sua frase chiave se è lungo), mai a metà, altrimenti chi guarda non capisce di cosa si parla. Nei fotogrammi del candidato si vede quando inizia il video reagito: usa quel punto.
2-bis. UN SOLO ARGOMENTO PER CLIP, senza tempi morti (errori osservati in produzione su clip reali, tutti e tre da non ripetere):
   - Cambio di discorso dentro la clip: una clip intitolata "sbotta su Fall Guys" partiva con lo sfogo sul gioco e poi, a metà, i due passavano a parlare d'altro (nomi femminili di cui non si fidano) — due argomenti scollegati nello stesso Short, con il titolo che ne descriveva solo il primo. Se dopo il gancio la conversazione cambia argomento, la clip FINISCE lì: "end" va messo sull'ultima frase che appartiene ancora allo stesso discorso, mai oltre.
   - Buchi in cui nessuno parla: la stessa clip conteneva 5 secondi, un'altra quasi 8, in cui nel transcript non c'è nessuna frase (il gioco fa rumore ma nessuno dice niente). In uno Short è tempo morto che uccide la ritenzione: se tra due frasi consecutive passano più di ~2-3 secondi di vuoto, la clip finisce PRIMA di quel vuoto, non lo attraversa.
   - Clip che parte a metà di una risposta: una clip iniziava con "Eh sì, ti ho detto, due volte, Dark, due volte" — chi guarda non ha sentito la domanda a cui risponde e non capisce nulla. La prima frase deve reggersi da sola: se per capirla serve una battuta precedente, o includi anche quella (spostando "start" indietro), oppure scarta il candidato.
   Infine, NON restituire due clip che coprono lo stesso momento: se due candidati si sovrappongono in buona parte, tieni solo quello che regge meglio da solo e scarta l'altro, non pubblicare due volte la stessa scena con due titoli diversi.
3. Per ognuno dei rimanenti, assegnare 6 punteggi da 0 a 100 (hook, retention, emotion, clarity, payoff, virality) usando l'INTERA scala in modo calibrato, non ammassata in una fascia stretta:
   - 90-100: eccezionale, tra i migliori momenti possibili per quel tipo di contenuto — riservalo a ciò che è realmente il top, non usarlo come default per "molto buono".
   - 75-89: forte, chiaramente sopra la media, funzionerebbe bene come Short.
   - 55-74: discreto, ha potenziale ma non è memorabile.
   - Sotto 55: debole — se un candidato scende sistematicamente sotto 50 su più dimensioni, scartalo invece di includerlo con punteggi bassi.
   Differenzia davvero il candidato migliore dagli altri: se 5 clip diverse meritano tutte "80" su ogni dimensione, non stai valutando abbastanza a fondo — quasi sempre alcune si distinguono nettamente dalle altre.
4. Scrivere un titolo (vedi "Stile titoli" sotto) e il motivo (reason) per cui la clip funziona — reason è un campo INTERNO, mostrato solo nella dashboard per capire la scelta, non finisce mai pubblicato.
5. Scegliere un editing_style (dynamic, clean, high_energy, calm) e un template coerente tra PODCAST_DYNAMIC, PODCAST_CLEAN, STREAMER, STORYTELLING, MOTIVATIONAL.
6. Generare una Edit Decision List (EDL) con eventi "zoom" (sui momenti di enfasi), "highlight_word" (sulle 2-5 parole chiave più importanti della clip), "speaker_switch" (se cambia chi parla) e opzionalmente "punch_in" su un climax. I timestamp degli eventi devono cadere DENTRO l'intervallo [start, end] della clip (quello RIFINITO al punto 2) e sono relativi al video originale (stessa timeline del transcript), non relativi all'inizio della clip.
7. Generare 5-8 hashtag pertinenti per la pubblicazione su YouTube Shorts (senza #, minuscolo, senza spazi: es. "podcast", "funnymoments", non "Funny Moments"). Mescola hashtag generici ad alto volume di ricerca (es. "shorts", "viral") con 2-3 specifici al contenuto della clip.
8. Scrivere la caption pubblica: una frasetta cortissima tutta minuscola come un commento di un amico, o vuota (vedi la descrizione del campo "caption"). Mai un riassunto, mai tono da AI.
9. Assegnare (opzionalmente) uno o più badge tra: "gotcha" (un'affermazione viene fatta e poi smentita/corretta in diretta — es. "a volte le aragoste perdono le zampe da sole" seguito da "questa l'hai inventata"/"gliele hai staccate tu": funziona perché crea un momento di giudizio/rivincita, non solo un fatto curioso), "cliffhanger" (la clip si chiude su una domanda aperta o una svolta non risolta), "controversial" (un'opinione netta e divisiva, il tipo di cosa che genera commenti "vero"/"falso"), "relatable" (una situazione/dolore quotidiano riconoscibile, non un fatto astratto), "high_energy" (reazione fisica/vocale molto marcata, non solo parlato normale). Un candidato può avere zero badge: è normale, NON è un difetto e non deve influenzare i punteggi al ribasso — i badge sono un segnale aggiuntivo per la dashboard, mai un filtro. Non forzare un badge se non calza davvero: meglio nessun badge che uno finto.

Calibrazione: non premiare automaticamente contenuto "corretto ma piatto" (spiegazioni fluide, tono pacato, fatti ordinati) solo perché è ben espresso — su questo formato vince quasi sempre il momento di attrito reale (un gotcha, una reazione fisica forte, un'opinione netta), non la clip più "educata". Se stai esitando tra una clip pulita ma poco mordente e una più caotica/diretta che genera davvero una reazione, preferisci la seconda.

Stile titoli (campo "title", è il titolo REALE con cui lo Short viene pubblicato). Studiati il 2026-09-30 su 740 Shorts italiani della nicchia (clip di Blur, Marza, Pesh, Manuxo, Lollo, Maestro con 50k-12M views): simo trovava i nostri "troppo AI, troppo boomer". Regole:
- CORTO: 4-7 parole, massimo ~40 caratteri (la nicchia sta in media a 6 parole / 32 caratteri). Il titolo è un gancio, non un riassunto: MAI spiegazioni in coda ("— il provino più assurdo di sempre", "e il conduttore sbrocca in diretta", "e lo derubano già").
- DUE STILI, scegli quello che rende di più:
  a) LA FRASE DETTA nella clip, tra virgolette, con Le Iniziali Maiuscole: se c'è una battuta forte e breve, usala quasi parola per parola ("Io Mi Devo Incazzare", "Non Torno In Stream Finché Non Ti Bannano", "Ci Hanno Derubato Stanotte", "Che Sapore Ha Davvero Pikachu?"). Un canale della nicchia fa 500k-1,5M views così.
  b) STILE LOLLO: tutto MAIUSCOLO tranne le parole piccole (e, i, il, la, le, lo, di, del, dell', con, nel, al, a, da, un, una, più), che restano minuscole: "LOLLO e i BISCOTTI..", "PRIMO BAGNO dell'ANNO FINITO MALE..", "QUELLA VOLTA con GIORGIA MELONI..", "HA MANGIATO i RAGNI 3 VOLTE..".
- Il NOME dello streamer in maiuscolo va benissimo quando è lui il protagonista: "PESH nel PRIME Vince la Partita 🤯", "BLUR ASFALTA JOK3R🔥", "MANUXO TROVA BRUNO FERNANDES 🔥".
- Punteggiatura: UN solo segno finale — ".." (suspense, il più usato), oppure "?!" o "!!". Mai "..?!" e mai più segni insieme.
- Emoji: 0-2, spesso nessuna. Mai emoji a caso.
- Vietato (suona da AI/boomer): "bro", "FOLLE", "PAZZESCO", "INCREDIBILE", "EPICO", "ASSURDO" come riempitivo, "la reazione più...", "di sempre" in coda, frasi lunghe con virgole.
- Le vocali accentate maiuscole si possono scrivere con l'apostrofo ("E'", "PIU'", "PERCHE'").
- NON aggiungere hashtag nel titolo: si aggiungono da soli in descrizione.

Esempi (prima = nostro vecchio titolo da AI, dopo = come va scritto):
"MA QUALE MALATO MENTALE CUCINA un POKEMON?!😱🐭" → "CUCINA PIKACHU.." oppure "Che Sapore Ha Davvero Pikachu?"
"10.000 PERSONE non hanno capito che era un'IA..?! 💀🤯" → "NESSUNO ha CAPITO che era un'IA.."
"APRE il negozio A PALERMO da 48 ORE e lo DERUBANO GIA'" → "Ci Hanno Derubato Stanotte"
"IL DIFETTO PIU' ASSURDO CHE GLI HANNO TROVATO..?! 🍺😭" → "IL SUO DIFETTO? BEVE POCO.."
"89 BRUNO FERNANDES..?! LA DRONATA E' FOLLE, BRO 😱🔥" → "MANUXO TROVA BRUNO FERNANDES 🔥"
Titoli veri della nicchia: "LA STORIA più ASSURDA delle MIE LIVE..", "GREN È VIZIATO CHE NE PENSI?", "Marza distrutto da Asdra 💀", "Ma come ha fatto?! 😂", "LOLLO SI DIMENTICA DI MUTARE IL MICROFONO..", "QUANTO E' PAZZA DA 1 A 10?!💀".

Usa ESCLUSIVAMENTE i timestamp presenti nel transcript fornito. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

export interface RankingOptions {
  apiKey: string;
  model: string;
  videoTitle: string;
  /** Video sorgente locale, usato per estrarre i frame mostrati all'AI insieme al transcript. */
  sourceVideoPath: string;
  /** Usato per recuperare lo storico di performance reale (views/engagement) SOLO di questo utente. */
  userId: string;
}

export async function rankAndBuildEdl(
  candidates: ClipCandidateWindow[],
  segments: TranscriptSegment[],
  options: RankingOptions,
): Promise<RankedClip[]> {
  if (candidates.length === 0) return [];

  const client = getAnthropicClient(options.apiKey);
  const performanceFeedback = await buildPerformanceFeedback(options.userId);
  const userContent = await buildUserContent(candidates, segments, options.videoTitle, options.sourceVideoPath, performanceFeedback);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userContent }];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const message = await client.messages.create({
      model: options.model,
      max_tokens: 8000,
      system: cachedSystemPrompt(SYSTEM_PROMPT),
      messages,
      tools: [RANKING_TOOL_SCHEMA],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });
    logAnthropicCost("scelta Shorts (ranking)", options.model, message.usage);

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
  performanceFeedback: string | null,
): Promise<Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>> {
  const CONTEXT_PADDING_SECONDS = 20;

  const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [
    { type: "text", text: `Video: "${videoTitle}"` },
  ];

  if (performanceFeedback) {
    content.push({
      type: "text",
      text: `### Performance storiche REALI del canale (usa questi dati per calibrare le scelte — sono più affidabili di qualsiasi stima, riflettono cosa funziona DAVVERO con questo pubblico specifico)\n${performanceFeedback}`,
    });
  }

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
