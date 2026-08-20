/**
 * Lettura delle variabili d'ambiente Supabase pubbliche (NEXT_PUBLIC_*).
 *
 * IMPORTANTE: Next.js sostituisce `process.env.NEXT_PUBLIC_X` con il valore letterale
 * nel bundle del browser SOLO se scritto come accesso statico diretto (`process.env.NOME`).
 * Un accesso dinamico come `process.env[nome]` (con `nome` variabile) NON viene individuato
 * dal suo compilatore e resta sempre `undefined` lato client, qualunque cosa sia configurata
 * su Vercel. Per questo le due funzioni sotto duplicano l'accesso invece di condividere un
 * helper generico con il nome della variabile come parametro.
 */
export function getSupabaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!value) {
    throw new Error("Variabile d'ambiente mancante: NEXT_PUBLIC_SUPABASE_URL. Controlla il tuo .env rispetto a .env.example.");
  }
  return value;
}

export function getSupabaseAnonKey(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!value) {
    throw new Error(
      "Variabile d'ambiente mancante: NEXT_PUBLIC_SUPABASE_ANON_KEY. Controlla il tuo .env rispetto a .env.example.",
    );
  }
  return value;
}
