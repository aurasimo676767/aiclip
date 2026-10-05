// Sicure automatiche di Claude Code per ClipForge (simo, 2026-10-05: "fai la 2 e la 3").
// Gira prima di ogni Read/Edit/Write/Bash/PowerShell. Uscita 2 = azione bloccata, il messaggio su
// stderr torna a Claude.
//
// 1. File .env intoccabili: lì ci sono i token di Telegram, Zernio, Anthropic, Supabase. Una volta
//    un altro agente ha sovrascritto il token del bot. Né leggerli né modificarli dagli strumenti
//    (i programmi del progetto li leggono lo stesso con dotenv, quello non passa da qui).
// 2. Niente modifiche al worker mentre lavora: tsx watch lo riavvia a ogni modifica di un file che
//    importa, e un render o un caricamento a metà si butta (2026-10-02, montato di Family Feud).
//    Se sta lavorando la modifica si blocca; si riprova quando ha finito.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let input = "";
for await (const chunk of process.stdin) input += chunk;
let event;
try {
  event = JSON.parse(input);
} catch {
  process.exit(0);
}
const tool = event.tool_name ?? "";
const args = event.tool_input ?? {};
const filePath = String(args.file_path ?? args.notebook_path ?? "");
const command = String(args.command ?? "");
const cwd = String(event.cwd ?? root);

function block(message) {
  process.stderr.write(message + "\n");
  process.exit(2);
}

// --- 1. .env ---------------------------------------------------------------------------------
const isEnvName = (name) => /^\.env(\..+)?$/i.test(name) && !/\.example$/i.test(name);
const ENV_BLOCK =
  "Bloccato dalla sicura di ClipForge: i file .env (token e chiavi) non si leggono né si modificano dagli strumenti. " +
  "Se simo chiede esplicitamente di cambiarne uno, digli quale riga cambiare e fallo fare a lui.";
if (filePath && isEnvName(path.basename(filePath))) block(ENV_BLOCK);
// Nei messaggi di commit e nei testi mandati su Telegram ".env" è solo una parola, non un file.
const textOnly = /^\s*(cd\s+\S+\s*&&\s*)?(git\s+(add|commit)\b|npx\s+tsx\s+src\/dev\/tg-send\.ts)/.test(command);
if (command && !textOnly && /(^|[\s"'`=\/\\])\.env(\.(local|production|development|test))?(?![\w.-])/i.test(command)) block(ENV_BLOCK);

// --- 2. worker al lavoro ---------------------------------------------------------------------
// File che il worker importa (e quindi lo riavviano). src/dev sono script a parte: non contano.
const WATCHED = /(apps[\/\\]worker[\/\\]src|packages[\/\\](shared|db)[\/\\]src)[\/\\](?!dev[\/\\])/i;
const isWrite = tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit";
let touchesWorker = isWrite && WATCHED.test(path.resolve(cwd, filePath));
if (!touchesWorker && command) {
  const writes = /sed\s+-i|writeFileSync|>>|(^|[^0-9&<-])>(?!&)|\b(cp|mv|rm|tee|touch)\b|Set-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item/.test(command);
  const inWorkerDir = WATCHED.test(path.join(cwd, "x")) || /apps[\/\\]worker$/i.test(cwd);
  const mentions = WATCHED.test(command) || (inWorkerDir && /(^|[\s"'])\.?\/?src[\/\\](?!dev[\/\\])/.test(command));
  touchesWorker = writes && mentions;
}
if (!touchesWorker) process.exit(0);

const res = spawnSync("npx", ["tsx", "src/dev/worker-busy.ts"], {
  cwd: path.join(root, "apps", "worker"),
  shell: true,
  encoding: "utf8",
  timeout: 45_000,
});
const line = (res.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
let status;
try {
  status = JSON.parse(line);
} catch {
  block(
    "Bloccato dalla sicura di ClipForge: non sono riuscito a controllare se il worker sta lavorando " +
      `(${(res.stderr ?? "").trim().slice(0, 200) || "nessuna risposta"}). Controlla a mano con renders-busy/busy-videos prima di modificare file del worker.`,
  );
}
if (status.busy) {
  block(
    `Bloccato dalla sicura di ClipForge: il worker sta lavorando (${status.reasons.join(", ")}). ` +
      "Modificare adesso un file che importa lo riavvia e butta via il lavoro. Aspetta che finisca " +
      "(es. un until-loop in background su apps/worker/src/dev/worker-busy.ts) e poi riprova.",
  );
}
process.exit(0);
