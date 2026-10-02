import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Ascolta i messaggi che simo scrive al bot Telegram e li stampa uno per riga (per il Monitor di
 * Claude Code). Le foto vengono salvate in <cartella>/tg-inbox/ (la didascalia, se c'è, finisce nel
 * nome del file). Solo la chat in TELEGRAM_CHAT_ID: i messaggi di chiunque altro si ignorano.
 * Uso: tsx src/dev/tg-listen.ts <cartella per le foto>
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedChat = process.env.TELEGRAM_CHAT_ID;
if (!token || !allowedChat) throw new Error("TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID mancanti nel .env");
const inbox = path.join(process.argv[2] ?? ".", "tg-inbox");
await fsp.mkdir(inbox, { recursive: true });
const api = (method: string) => `https://api.telegram.org/bot${token}/${method}`;

type Photo = { file_id: string; width: number; height: number };
type Update = { update_id: number; message?: { chat: { id: number }; text?: string; caption?: string; photo?: Photo[]; document?: { file_id: string; mime_type?: string; file_name?: string }; audio?: { file_id: string }; video?: { file_id: string; file_size?: number }; video_note?: { file_id: string }; animation?: { file_id: string }; voice?: { file_id: string }; reply_to_message?: { text?: string; caption?: string; audio?: { title?: string }; video?: unknown; photo?: unknown } } };

async function saveFile(fileId: string, name: string): Promise<string> {
  const info = (await (await fetch(`${api("getFile")}?file_id=${fileId}`)).json()) as { result?: { file_path?: string } };
  const remote = info.result?.file_path;
  if (!remote) throw new Error("getFile senza percorso");
  const ext = path.extname(remote) || ".jpg";
  const local = path.join(inbox, `${name}${ext}`);
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${remote}`);
  await fsp.writeFile(local, Buffer.from(await res.arrayBuffer()));
  return local;
}

// Si parte dai messaggi NUOVI: quelli già presenti si saltano.
let offset = 0;
const first = (await (await fetch(api("getUpdates"))).json()) as { result?: Update[] };
for (const u of first.result ?? []) offset = Math.max(offset, u.update_id + 1);

while (true) {
  try {
    const res = (await (await fetch(`${api("getUpdates")}?timeout=25&offset=${offset}`)).json()) as { result?: Update[] };
    for (const u of res.result ?? []) {
      offset = Math.max(offset, u.update_id + 1);
      const m = u.message;
      if (!m || String(m.chat.id) !== allowedChat) continue;
      const caption = (m.caption ?? "").replace(/[^\p{L}\p{N} ]+/gu, "").trim().replace(/\s+/g, "_").slice(0, 40);
      let saved = "";
      if (m.photo?.length) {
        const biggest = [...m.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
        saved = await saveFile(biggest.file_id, `${u.update_id}${caption ? "-" + caption : ""}`);
      } else if (m.document?.mime_type?.startsWith("image/")) {
        saved = await saveFile(m.document.file_id, `${u.update_id}${caption ? "-" + caption : ""}`);
      } else {
        // Video (anche TikTok salvati e inoltrati), video tondi, gif e vocali: si salvano per
        // guardarli (fotogrammi + trascrizione). Il bot scarica file fino a 20 MB.
        // Qualsiasi altro file (pdf, zip, audio...): si salva col suo nome per passarlo dal telefono al PC.
        const media = m.video ?? m.video_note ?? m.animation ?? m.voice ?? m.audio ?? m.document;
        if (media) saved = await saveFile(media.file_id, `${u.update_id}${caption ? "-" + caption : ""}`).catch((e) => `ERRORE: ${e instanceof Error ? e.message : e} (oltre 20 MB?)`);
      }
      const text = (m.text ?? m.caption ?? "").replace(/\s+/g, " ");
      // Se risponde a un messaggio del bot (es. "questo" su uno dei suoni), si dice a quale.
      const r = m.reply_to_message;
      const replyTo = r ? (r.audio?.title ?? r.caption ?? r.text ?? (r.video ? "un video" : r.photo ? "una foto" : "un messaggio")).replace(/s+/g, " ").slice(0, 80) : null;
      console.log(`TELEGRAM da simo: ${text}${replyTo ? ` [in risposta a: ${replyTo}]` : ""}${saved ? ` [file salvato: ${saved}]` : ""}`);
    }
  } catch (error) {
    console.error(`tg-listen: ${error instanceof Error ? error.message : error}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
