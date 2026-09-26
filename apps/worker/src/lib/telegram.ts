/**
 * Messaggi al bot Telegram di simo (token e chat nel .env, mai nel codice). Solo per gli strumenti
 * di sviluppo: il worker in produzione non ne dipende.
 */
export async function sendTelegramText(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error("TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID mancanti nel .env");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  });
  if (!res.ok) throw new Error(`sendMessage: ${res.status} ${await res.text()}`);
}
