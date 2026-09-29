import "dotenv/config";

/**
 * Verifica ZERNIO_API_KEY e mostra gli account collegati e le info TikTok (solo letture, gratis):
 * per controllare il collegamento prima di pubblicare. Non stampa la chiave.
 * Uso: tsx src/dev/check-zernio.ts
 */
const key = process.env.ZERNIO_API_KEY;
if (!key) throw new Error("ZERNIO_API_KEY mancante nel .env");
const get = async (path: string) => {
  const res = await fetch(`https://zernio.com/api/v1${path}`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: res.status, body: (await res.text()).slice(0, 1500) };
};
const acc = await get("/accounts");
console.log("ACCOUNTS", acc.status, acc.body);
const m = acc.body.match(/"_id"\s*:\s*"([^"]+)"[^}]*"platform"\s*:\s*"tiktok"|"platform"\s*:\s*"tiktok"[^}]*"_id"\s*:\s*"([^"]+)"/);
const id = m?.[1] ?? m?.[2];
if (id) {
  const info = await get(`/accounts/${id}/tiktok/creator-info`);
  console.log("CREATOR-INFO", info.status, info.body);
}
