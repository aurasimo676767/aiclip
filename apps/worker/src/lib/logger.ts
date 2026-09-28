import fs from "node:fs";
import path from "node:path";

type LogFields = Record<string, unknown>;

function format(level: string, message: string, fields?: LogFields): string {
  const ts = new Date().toISOString();
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  return `[${ts}] [${level}] ${message}${suffix}`;
}

// Il worker scrive anche su file (tmp/logs/worker-AAAA-MM-GG.log): i log del terminale non restano,
// e il 2026-09-28 un montaggio fallito in silenzio non si è potuto capire. Solo il worker vero
// (src/index.ts), non gli script di src/dev.
const isWorker = process.argv.some((a) => /src[\\/]index\.ts$/.test(a));
const LOG_DIR = path.resolve(process.cwd(), "tmp", "logs");
if (isWorker) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // senza cartella si logga solo a terminale
  }
}

function toFile(line: string) {
  if (!isWorker) return;
  try {
    fs.appendFileSync(path.join(LOG_DIR, `worker-${new Date().toISOString().slice(0, 10)}.log`), line + "\n");
  } catch {
    // il log su file non deve mai far fallire il lavoro
  }
}

export const logger = {
  info(message: string, fields?: LogFields) {
    const line = format("INFO", message, fields);
    console.log(line);
    toFile(line);
  },
  warn(message: string, fields?: LogFields) {
    const line = format("WARN", message, fields);
    console.warn(line);
    toFile(line);
  },
  error(message: string, fields?: LogFields) {
    const line = format("ERROR", message, fields);
    console.error(line);
    toFile(line);
  },
};
