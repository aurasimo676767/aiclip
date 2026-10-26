import "dotenv/config";

/**
 * Spesa VERA su OpenAI dalle loro statistiche (gratis), per giorno e per voce. Serve una chiave che
 * possa leggere i costi dell'organizzazione; con una chiave normale OpenAI risponde 401/403.
 * Uso: tsx src/dev/openai-costs.ts [giorni=2]
 */
const days = Number(process.argv[2] ?? 2);
const start = Math.floor(Date.now() / 1000) - days * 86400;
const res = await fetch(`https://api.openai.com/v1/organization/costs?start_time=${start}&bucket_width=1d&group_by=line_item&limit=${days + 1}`, {
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
});
const text = await res.text();
if (!res.ok) {
  console.log(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
  process.exit(0);
}
const data = JSON.parse(text) as { data: Array<{ start_time: number; results: Array<{ line_item: string | null; amount: { value: number } }> }> };
for (const day of data.data) {
  const date = new Date(day.start_time * 1000).toISOString().slice(0, 10);
  const total = day.results.reduce((s, r) => s + r.amount.value, 0);
  console.log(`${date}  totale $${total.toFixed(4)}`);
  for (const r of day.results.sort((a, b) => b.amount.value - a.amount.value)) console.log(`   $${r.amount.value.toFixed(4)}  ${r.line_item ?? "?"}`);
}
