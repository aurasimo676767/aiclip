import "dotenv/config";

/**
 * Verifica che TIKTOK_CLIENT_KEY/SECRET del .env siano una coppia valida (client_credentials),
 * senza stamparli: dice solo se TikTok li accetta e se hanno spazi o virgolette di troppo.
 * Uso: tsx src/dev/check-tiktok-keys.ts
 */
const key = process.env.TIKTOK_CLIENT_KEY ?? "";
const secret = process.env.TIKTOK_CLIENT_SECRET ?? "";
const dirty = (v: string) => v !== v.trim() || /^["']|["']$/.test(v);
console.log(JSON.stringify({ lunghezzaKey: key.length, lunghezzaSecret: secret.length, spaziOVirgoletteKey: dirty(key), spaziOVirgoletteSecret: dirty(secret) }));
const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_key: key.trim(), client_secret: secret.trim(), grant_type: "client_credentials" }),
});
const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
console.log(json.access_token ? "TikTok ACCETTA questa coppia key/secret" : `TikTok RIFIUTA: ${json.error_description ?? json.error}`);
