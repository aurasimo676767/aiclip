"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  House,
  Clapperboard,
  Radio,
  MonitorPlay,
  Mic,
  Settings,
  LogOut,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  UserRound,
  Captions,
  ImageIcon,
  Loader,
  type LucideIcon,
} from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { WorkerPauseControl } from "./worker-pause-control";
import { TooltipProvider } from "./ui-kit/menu";
import { Logo } from "./ui-kit/logo";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

const NAV_GROUPS: Array<{ title?: string; items: NavItem[] }> = [
  {
    items: [
      { href: "/dashboard", label: "Home", icon: House, exact: true },
      { href: "/dashboard/completed", label: "Progetti", icon: Clapperboard },
      { href: "/dashboard/processing", label: "In lavorazione", icon: Loader },
      { href: "/dashboard/published", label: "Pubblicati", icon: MonitorPlay },
    ],
  },
  {
    title: "Strumenti",
    items: [
      { href: "/dashboard/stili", label: "Stili sottotitoli", icon: Captions },
      { href: "/dashboard/thumbnails", label: "Copertine", icon: ImageIcon },
      { href: "/dashboard/faces", label: "Facce", icon: UserRound },
      { href: "/dashboard/feed", label: "Canali", icon: Radio },
      { href: "/dashboard/whop", label: "Voice over", icon: Mic },
      { href: "/dashboard/settings", label: "Opzioni", icon: Settings },
    ],
  },
];

const MOBILE_TABS: Array<NavItem & { short: string }> = [
  { href: "/dashboard", label: "Home", short: "Home", icon: House, exact: true },
  { href: "/dashboard/completed", label: "Progetti", short: "Progetti", icon: Clapperboard },
];
const MOBILE_TABS_RIGHT: Array<NavItem & { short: string }> = [{ href: "/dashboard/published", label: "Pubblicati", short: "Pubblicati", icon: MonitorPlay }];
const MORE_ITEMS: NavItem[] = NAV_GROUPS[1]!.items.concat([{ href: "/dashboard/processing", label: "In lavorazione", icon: Loader }]);

function isActive(pathname: string, item: NavItem): boolean {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");
}

/**
 * Barra in basso come un'app (l'editor e simo usano il sito dal telefono): Home, Progetti, il "+" al
 * centro per un nuovo video, Pubblicati, e "Altro" che apre un pannello dal basso con gli strumenti.
 * Vetro sfocato sopra il contenuto che ci scorre sotto.
 */
function MobileTabBar({ pathname, onMore, moreOpen }: { pathname: string; onMore: () => void; moreOpen: boolean }) {
  const moreActive = moreOpen || MORE_ITEMS.some((i) => isActive(pathname, i));
  const tab = (item: NavItem & { short: string }) => {
    const active = isActive(pathname, item);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-label={item.label}
        aria-current={active ? "page" : undefined}
        className={`flex flex-col items-center justify-center gap-1 pb-1.5 pt-2 text-[11px] font-medium transition-colors duration-150 active:scale-95 ${active ? "text-ink" : "text-faint"}`}
      >
        <Icon size={22} strokeWidth={active ? 2.2 : 1.8} className={active ? "text-brand-300" : undefined} />
        {item.short}
      </Link>
    );
  };
  return (
    <nav
      aria-label="Navigazione"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-white/[0.06] bg-canvas/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl backdrop-saturate-150 md:hidden"
    >
      {MOBILE_TABS.map(tab)}
      <div className="flex items-center justify-center">
        <Link
          href="/dashboard#nuovo"
          aria-label="Nuovo video"
          className="flex h-11 w-14 items-center justify-center rounded-2xl bg-brand-500 text-white transition-transform duration-150 ease-out active:scale-95"
          style={{ boxShadow: "0 1px 0 0 rgba(255,255,255,0.2) inset, 0 8px 18px -8px rgba(53,112,242,0.9)" }}
        >
          <Plus size={24} strokeWidth={2.4} />
        </Link>
      </div>
      {MOBILE_TABS_RIGHT.map(tab)}
      <button
        onClick={onMore}
        aria-expanded={moreOpen}
        className={`flex flex-col items-center justify-center gap-1 pb-1.5 pt-2 text-[11px] font-medium transition-colors duration-150 active:scale-95 ${moreActive ? "text-ink" : "text-faint"}`}
      >
        <LayoutGrid size={22} strokeWidth={moreActive ? 2.2 : 1.8} className={moreActive ? "text-brand-300" : undefined} />
        Altro
      </button>
    </nav>
  );
}

/** Pannello "Altro" dal basso: gli strumenti a riquadri grandi da pollice, la pausa del PC e l'uscita. */
function MoreSheet({ open, onClose, pathname, email, onSignOut }: { open: boolean; onClose: () => void; pathname: string; email: string; onSignOut: () => void }) {
  return (
    <div className={`fixed inset-0 z-50 md:hidden ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <button
        aria-label="Chiudi"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`}
      />
      <div
        role="dialog"
        aria-label="Altro"
        className={`absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-white/[0.08] bg-surface px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-2.5 shadow-pop ${open ? "translate-y-0" : "translate-y-full"}`}
        style={{ transition: "transform 380ms var(--ease-drawer)" }}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />
        <div className="grid grid-cols-3 gap-2">
          {MORE_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                tabIndex={open ? 0 : -1}
                className={`flex flex-col items-center justify-center gap-2 rounded-2xl border px-2 py-4 text-center text-xs font-medium transition active:scale-[0.97] ${
                  active ? "border-brand-400/40 bg-brand-500/10 text-ink" : "border-white/[0.06] bg-white/[0.03] text-muted"
                }`}
              >
                <Icon size={22} strokeWidth={1.8} className={active ? "text-brand-300" : "text-ink"} />
                {item.label}
              </Link>
            );
          })}
        </div>
        <div className="mt-4 space-y-1 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-2">
          <WorkerPauseControl />
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <p className="truncate text-xs text-faint">{email}</p>
            <button onClick={onSignOut} tabIndex={open ? 0 : -1} className="btn btn-ghost btn-sm -mr-2">
              <LogOut size={14} /> Esci
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const COLLAPSED_STORAGE_KEY = "clipforge:sidebar-collapsed";

export function DashboardShell({ email, children }: { email: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1") setCollapsed(true);
    } catch {
      // storage non disponibile: resta espansa
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      try {
        window.localStorage.setItem(COLLAPSED_STORAGE_KEY, prev ? "0" : "1");
      } catch {
        // ignorato
      }
      return !prev;
    });
  }

  // Il pannello "Altro" si chiude a ogni cambio pagina e con Esc.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMoreOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  function renderNav(iconOnly: boolean) {
    return (
      <nav className="space-y-6">
        {NAV_GROUPS.map((group, i) => (
          <div key={i} className="space-y-0.5">
            {group.title && !iconOnly && <p className="px-3 pb-1.5 text-[11px] font-medium text-faint">{group.title}</p>}
            {group.title && iconOnly && <div className="mx-3 mb-2 border-t border-line" />}
            {group.items.map((item) => {
              const active = isActive(pathname, item);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={iconOnly ? item.label : undefined}
                  aria-current={active ? "page" : undefined}
                  className={`group flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors duration-150 ${
                    active ? "bg-white/[0.07] font-medium text-white" : "text-muted hover:bg-white/[0.04] hover:text-ink"
                  } ${iconOnly ? "justify-center px-0" : ""}`}
                >
                  <Icon size={18} strokeWidth={active ? 2.1 : 1.8} className={active ? "text-brand-300" : "text-faint group-hover:text-muted"} />
                  {!iconOnly && item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex min-h-screen">
        {/* Barra laterale desktop: espansa o ridotta a sole icone */}
        <aside
          className={`sticky top-0 z-20 hidden h-screen shrink-0 flex-col justify-between border-r border-white/[0.05] bg-canvas p-3 transition-[width] duration-200 ease-out md:flex ${
            collapsed ? "w-[68px]" : "w-60"
          }`}
        >
          <div className="space-y-6 overflow-y-auto">
            <div className={`flex items-center pt-1 ${collapsed ? "flex-col gap-3" : "justify-between px-2"}`}>
              <Logo iconOnly={collapsed} />
              <button
                onClick={toggleCollapsed}
                className="rounded-lg p-1.5 text-faint transition-colors hover:bg-white/[0.06] hover:text-ink"
                aria-label={collapsed ? "Espandi menu" : "Riduci menu"}
                title={collapsed ? "Espandi menu" : "Riduci menu"}
              >
                {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
              </button>
            </div>
            <Link href="/dashboard#nuovo" title="Nuovo video" className={`btn btn-primary w-full ${collapsed ? "px-0" : ""}`}>
              <Plus size={16} />
              {!collapsed && "Nuovo video"}
            </Link>
            {renderNav(collapsed)}
          </div>
          <div className="space-y-2 border-t border-line pt-4">
            <WorkerPauseControl compact={collapsed} />
            {!collapsed && <p className="truncate px-3 pt-1 text-xs text-faint">{email}</p>}
            <button
              onClick={handleSignOut}
              title="Esci"
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted transition-colors hover:bg-white/[0.05] hover:text-ink ${collapsed ? "justify-center px-0" : ""}`}
            >
              <LogOut size={18} className="text-faint" />
              {!collapsed && "Esci"}
            </button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Barra superiore mobile */}
          <header className="sticky top-0 z-30 flex items-center justify-between border-b border-white/[0.05] bg-canvas/75 px-4 py-2.5 backdrop-blur-xl backdrop-saturate-150 md:hidden">
            <Logo />
          </header>

          {/* Sul telefono la barra in basso copre gli ultimi ~80px: il contenuto finisce sopra. */}
          <main className="min-w-0 flex-1 px-4 pb-28 pt-5 sm:px-6 md:px-10 md:py-10">{children}</main>
          <MobileTabBar pathname={pathname} onMore={() => setMoreOpen(true)} moreOpen={moreOpen} />
          <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} pathname={pathname} email={email} onSignOut={handleSignOut} />
        </div>
      </div>
    </TooltipProvider>
  );
}
