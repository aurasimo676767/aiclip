import { Suspense } from "react";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { LogoMark } from "@/components/ui-kit/logo";
import { CaptionHeadline } from "@/components/ui-kit/caption-headline";

export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-5 text-center">
          <Link href="/" aria-label="ClipForge" className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70">
            <LogoMark size={44} />
          </Link>
          <div className="space-y-2">
            <CaptionHeadline text="Crea il tuo account" className="text-3xl" />
            <p className="text-sm text-muted">Inizia a trasformare le live in clip</p>
          </div>
        </div>
        <div className="card p-6">
          <Suspense>
            <AuthForm mode="signup" />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
