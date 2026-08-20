"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Ricarica i dati della pagina (Server Component) a intervalli regolari finché `active` è true. */
export function PollingRefresher({ active, intervalMs = 4000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);

  return null;
}
