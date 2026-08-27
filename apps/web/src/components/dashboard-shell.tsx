"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", exact: true },
  { href: "/dashboard/feed", label: "Feed" },
  { href: "/dashboard/published", label: "Pubblicati" },
  { href: "/dashboard/whop", label: "Whop" },
  { href: "/dashboard/settings", label: "Opzioni" },
];

const COLLAPSED_STORAGE_KEY = "clipforge:sidebar-collapsed";

export function DashboardShell({ email, children }: { email: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Preferenza di collasso della sidebar desktop, ricordata tra le sessioni.
  useEffect(() => {
    if (window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1") setCollapsed(true);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // Chiude il drawer mobile ad ogni cambio pagina.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const navLinks = (
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
  );

  const accountFooter = (
    <div className="space-y-2 border-t border-zinc-800 pt-4">
      <p className="truncate px-2 text-xs text-zinc-500">{email}</p>
      <button
        onClick={handleSignOut}
        className="w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-400 transition hover:bg-zinc-800/60 hover:text-zinc-100"
      >
        Esci
      </button>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* Sidebar desktop, collassabile */}
      <aside
        className={`hidden shrink-0 flex-col justify-between overflow-hidden border-zinc-800 bg-zinc-950/60 transition-[width] duration-200 md:flex ${
          collapsed ? "w-0 border-r-0 p-0" : "w-60 border-r p-4"
        }`}
      >
        <div className="w-56">
          <div className="mb-8 flex items-center justify-between px-2">
            <Link href="/dashboard" className="text-lg font-bold tracking-tight text-white">
              ClipForge
            </Link>
            <button
              onClick={() => setCollapsed(true)}
              className="rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
              aria-label="Nascondi menu"
              title="Nascondi menu"
            >
              <ChevronLeftIcon />
            </button>
          </div>
          {navLinks}
        </div>
        <div className="w-56">{accountFooter}</div>
      </aside>

      {/* Backdrop + drawer mobile */}
      {mobileOpen && (
        <button
          aria-label="Chiudi menu"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 max-w-[80vw] flex-col justify-between border-r border-zinc-800 bg-zinc-950 p-4 transition-transform duration-200 md:hidden ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div>
          <div className="mb-8 flex items-center justify-between px-2">
            <Link href="/dashboard" className="text-lg font-bold tracking-tight text-white">
              ClipForge
            </Link>
            <button
              onClick={() => setMobileOpen(false)}
              className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              aria-label="Chiudi menu"
            >
              <CloseIcon />
            </button>
          </div>
          {navLinks}
        </div>
        {accountFooter}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barra superiore mobile */}
        <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3 md:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Apri menu"
            className="rounded-md p-1.5 text-zinc-300 transition hover:bg-zinc-800"
          >
            <MenuIcon />
          </button>
          <span className="text-base font-bold text-white">ClipForge</span>
        </header>

        {/* Pulsante per far ricomparire la sidebar desktop quando collassata */}
        {collapsed && (
          <div className="hidden border-b border-zinc-800 px-4 py-2 md:block">
            <button
              onClick={() => setCollapsed(false)}
              className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
              aria-label="Mostra menu"
              title="Mostra menu"
            >
              <ChevronRightIcon />
            </button>
          </div>
        )}

        <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">{children}</main>
      </div>
    </div>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
