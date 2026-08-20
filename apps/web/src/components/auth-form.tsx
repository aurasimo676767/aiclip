"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

interface AuthFormProps {
  mode: "login" | "signup";
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setInfoMessage(null);

    try {
      const supabase = createSupabaseBrowserClient();

      if (mode === "signup") {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        if (signUpError) {
          setError(signUpError.message);
          return;
        }
        setInfoMessage("Controlla la tua email per confermare la registrazione.");
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
        return;
      }

      const next = searchParams.get("next") ?? "/dashboard";
      router.push(next);
      router.refresh();
    } catch (err) {
      // Es. variabili d'ambiente Supabase mancanti nel build: senza questo catch il
      // pulsante restava bloccato su "Attendere..." senza alcun messaggio per l'utente.
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium text-zinc-300">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-brand-400"
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm font-medium text-zinc-300">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-brand-400"
        />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {infoMessage && <p className="text-sm text-emerald-400">{infoMessage}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
      >
        {loading ? "Attendere..." : mode === "signup" ? "Crea account" : "Accedi"}
      </button>

      <p className="text-center text-sm text-zinc-500">
        {mode === "signup" ? (
          <>
            Hai già un account?{" "}
            <Link href="/login" className="text-brand-300 hover:underline">
              Accedi
            </Link>
          </>
        ) : (
          <>
            Non hai un account?{" "}
            <Link href="/signup" className="text-brand-300 hover:underline">
              Registrati
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
