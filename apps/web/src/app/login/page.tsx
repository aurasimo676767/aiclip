import { Suspense } from "react";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";

export default function LoginPage() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12">
      <div className="pointer-events-none absolute left-1/2 top-0 h-80 w-[40rem] -translate-x-1/2 rounded-full bg-brand-500/20 blur-3xl" />
      <div className="relative w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <Link href="/" className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-gradient shadow-glow">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M8 5v14l11-7L8 5z" fill="white" />
            </svg>
          </Link>
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Bentornato</h1>
            <p className="mt-1 text-sm text-muted">Accedi a ClipForge</p>
          </div>
        </div>
        <div className="card p-6">
          <Suspense>
            <AuthForm mode="login" />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
