"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const NAV_ITEMS = [
  { href: "/dashboard/new", label: "New Project" },
  { href: "/dashboard", label: "Projects", exact: true },
  { href: "/dashboard/processing", label: "Processing" },
  { href: "/dashboard/completed", label: "Completed" },
  { href: "/dashboard/credits", label: "Credits & Usage" },
  { href: "/dashboard/settings", label: "Settings" },
];

export function SidebarNav({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col justify-between border-r border-zinc-800 bg-zinc-950/60 p-4">
      <div>
        <Link href="/dashboard" className="mb-8 block px-2 text-lg font-bold tracking-tight text-white">
          ClipForge
        </Link>
        <nav className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive ? "bg-brand-500/15 text-brand-200" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="space-y-2 border-t border-zinc-800 pt-4">
        <p className="truncate px-2 text-xs text-zinc-500">{email}</p>
        <button
          onClick={handleSignOut}
          className="w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-400 transition hover:bg-zinc-800/60 hover:text-zinc-100"
        >
          Esci
        </button>
      </div>
    </aside>
  );
}
