import "dotenv/config";

/**
 * Elenca i modelli di testo che la chiave OpenAI può usare (chiamata gratuita, non consuma credito).
 * Uso: tsx src/dev/openai-models.ts
 */
const res = await fetch("https://api.openai.com/v1/models", {
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
});
if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
const { data } = (await res.json()) as { data: Array<{ id: string; created: number }> };
const text = data
  .filter((m) => /^(gpt-|o\d)/.test(m.id) && !/image|audio|realtime|tts|transcribe|search|embedding/.test(m.id))
  .sort((a, b) => b.created - a.created);
for (const m of text) console.log(new Date(m.created * 1000).toISOString().slice(0, 10), m.id);
