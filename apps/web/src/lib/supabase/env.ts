/**
 * Lettura "pigra" (non al top-level del modulo) delle variabili d'ambiente Supabase.
 * Next.js importa i moduli delle Route Handler durante `next build` per raccoglierne i
 * metadati, anche senza eseguire realmente una richiesta: se questo file lanciasse
 * un'eccezione a livello di modulo (es. `const X = requireEnv(...)`), la build fallirebbe
 * ogni volta che le variabili non sono definite in fase di build — anche per route che le
 * useranno solo a runtime. Le funzioni sotto vengono quindi chiamate dentro le factory dei
 * client Supabase, non a module scope.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variabile d'ambiente mancante: ${name}. Controlla il tuo .env rispetto a .env.example.`);
  }
  return value;
}

export function getSupabaseUrl(): string {
  return requireEnv("NEXT_PUBLIC_SUPABASE_URL");
}

export function getSupabaseAnonKey(): string {
  return requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}
