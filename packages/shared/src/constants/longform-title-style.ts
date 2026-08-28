// Alias con cui certe persone vanno SEMPRE indicate nei titoli long-form (invece del loro nome
// reale/handle) — convenzione dei titoli di reaction/gameplay italiani che già usa lo streamer.
// Chiave in minuscolo per il confronto, valore il nickname esatto da usare nel titolo.
// Condiviso tra il ranking IA del worker e la rigenerazione titolo lato sito, per non avere due
// prompt che possono andare fuori sync.
export const LONGFORM_STREAMER_ALIASES: Record<string, string> = {
  tumblurr: "BLUR",
  justmarza: "MARZA",
  pesh: "PESH",
  manuxoo: "MANUXO",
};

function formatAliasGlossary(): string {
  return Object.entries(LONGFORM_STREAMER_ALIASES)
    .map(([real, alias]) => `- ${real} → ${alias}`)
    .join("\n");
}

/** Blocco di istruzioni sulla convenzione dei titoli long-form, da inserire nel system prompt. */
export function buildLongformTitleStylePrompt(): string {
  return `Alias per i titoli — usa SEMPRE questi al posto del nome reale quando riconosci una di queste persone (anche se nel transcript il nome compare storpiato dalla trascrizione automatica, riconoscilo comunque per assonanza):
${formatAliasGlossary()}
Nota: per "justmarza" usa "MARZA" di norma, ma "MARZONE" se calza meglio nel contesto (tono scherzoso/enfatico) — usa il giudizio.
Se nel segmento è presente un'altra persona che gioca/parla insieme e NON è in questa lista, inventa un nickname breve e naturale in MAIUSCOLO a partire dal suo nome/handle (stesso stile degli altri).

Stile titoli (campo "title" — è il titolo REALE con cui il video viene pubblicato): per il long-form NON si usa lo stile "urlato" da Short (niente MAIUSCOLO diffuso su tutto il titolo, niente punteggiatura doppia tipo "?!"/"!!"), TRANNE per i due formati fissi sotto, dove gli alias restano in maiuscolo per convenzione:

1. REACTION (il segmento è la persona/le persone che reagiscono/guardano/commentano un contenuto esterno — video, notizia, TikTok, trailer, ecc.): "{ALIAS} REACTION: {argomento descritto in modo naturale}" — es. "BLUR REACTION: il trailer di GTA 6".
2. GAMEPLAY in solitaria (nessun altro partecipante riconoscibile nel segmento): "{ALIAS} GIOCA A {nome gioco}".
3. GAMEPLAY in compagnia (una o più altre persone riconoscibili giocano/parlano insieme nel segmento): "{ALIAS}, {ALIAS2}, {ALIAS3} GIOCANO A {nome gioco}" — elenca tutti i partecipanti riconosciuti separati da virgola, verbo al plurale.
4. Qualsiasi altro tipo di segmento (discussioni, just chatting, momenti non riconducibili a reaction o gameplay): stile descrittivo, es. "{Alias} racconta [cosa]", "Il momento in cui {Alias} scopre [cosa]" — qui l'alias va scritto con iniziale maiuscola normale (es. "Blur", non "BLUR"), non tutto maiuscolo.

Massimo ~100 caratteri.`;
}
