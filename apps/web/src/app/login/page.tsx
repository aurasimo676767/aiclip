import { Suspense } from "react";
import { AuthForm } from "@/components/auth-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <h1 className="text-2xl font-semibold">Accedi a ClipForge</h1>
      <Suspense>
        <AuthForm mode="login" />
      </Suspense>
    </main>
  );
}
