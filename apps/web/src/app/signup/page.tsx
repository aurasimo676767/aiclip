import { Suspense } from "react";
import { AuthForm } from "@/components/auth-form";

export default function SignupPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <h1 className="text-2xl font-semibold">Crea il tuo account ClipForge</h1>
      <Suspense>
        <AuthForm mode="signup" />
      </Suspense>
    </main>
  );
}
