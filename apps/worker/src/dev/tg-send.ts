import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Manda immagini al bot Telegram di simo (anteprime delle prove, es. copertine). La chat è quella
 * di chi ha premuto "Avvia" sul bot: si ricava da getUpdates la prima volta e si salva in
 * TELEGRAM_CHAT_ID nel .env. Il token sta solo nel .env (mai nel codice).
 * Uso: tsx src/dev/tg-send.ts "<testo>" [immagine...]   (senza immagini = solo testo; fino a 10 = un album)
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN mancante nel .env");
const [rawCaption, ...files] = process.argv.slice(2);
// Su Windows npx passa da cmd.exe, che taglia gli argomenti al primo a capo: i testi lunghi si
// passano da file con @percorso.
const caption = rawCaption?.startsWith("@") ? await fsp.readFile(rawCaption.slice(1), "utf8") : rawCaption;
if (!caption) throw new Error('Uso: tsx src/dev/tg-send.ts "<testo>" [immagine...]');

const api = (method: string) => `https://api.telegram.org/bot${token}/${method}`;

async function chatId(): Promise<string> {
  if (process.env.TELEGRAM_CHAT_ID) return process.env.TELEGRAM_CHAT_ID;
  const res = (await (await fetch(api("getUpdates"))).json()) as { result?: Array<{ message?: { chat?: { id: number } } }> };
  const id = res.result?.map((u) => u.message?.chat?.id).find(Boolean);
  if (!id) throw new Error("Nessuna chat: bisogna prima premere Avvia sul bot");
  await fsp.appendFile(".env", `TELEGRAM_CHAT_ID=${id}\n`);
  return String(id);
}

const chat = await chatId();
if (files.length === 0) {
  const res = await fetch(api("sendMessage"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: caption }) });
  if (!res.ok) throw new Error(`sendMessage: ${await res.text()}`);
}
for (let i = 0; i < files.length; i += 10) {
  const group = files.slice(i, i + 10);
  const form = new FormData();
  form.append("chat_id", chat);
  if (group.length === 1) {
    form.append("caption", caption.slice(0, 1000));
    form.append("photo", new Blob([await fsp.readFile(group[0]!)]), path.basename(group[0]!));
    const res = await fetch(api("sendPhoto"), { method: "POST", body: form });
    if (!res.ok) throw new Error(`sendPhoto: ${await res.text()}`);
  } else {
    const media = group.map((f, j) => ({ type: "photo", media: `attach://f${j}`, ...(j === 0 && i === 0 ? { caption: caption.slice(0, 1000) } : {}) }));
    form.append("media", JSON.stringify(media));
    for (const [j, f] of group.entries()) form.append(`f${j}`, new Blob([await fsp.readFile(f)]), path.basename(f));
    const res = await fetch(api("sendMediaGroup"), { method: "POST", body: form });
    if (!res.ok) throw new Error(`sendMediaGroup: ${await res.text()}`);
  }
}
console.log(`inviate ${files.length} immagini`);
