"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Home,
  Loader,
  CheckCircle2,
  Radio,
  MonitorPlay,
  Mic,
  Settings,
  LogOut,
  Menu,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  UserRound,
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
      { href: "/dashboard", label: "Home", icon: Home, exact: true },
      { href: "/dashboard/processing", label: "In lavorazione", icon: Loader },
      { href: "/dashboard/completed", label: "Completati", icon: CheckCircle2 },
    ],
  },
  {
    title: "Canali",
    items: [
      { href: "/dashboard/feed", label: "Feed", icon: Radio },
      { href: "/dashboard/published", label: "Pubblicati", icon: MonitorPlay },
    ],
  },
  {
    title: "Strumenti",
    items: [
      { href: "/dashboard/whop", label: "Voice over", icon: Mic },
      { href: "/dashboard/faces", label: "Facce", icon: UserRound },
      { href: "/dashboard/settings", label: "Opzioni", icon: Settings },
    ],
  },
];

/**
 * Barra in basso come un'app (simo usa il sito soprattutto dal telefono): le pagine di tutti i
 * giorni a un tocco col pollice, il "+" giallo al centro per un nuovo progetto, il resto in "Altro".
 * Prima c'era solo il menu a panino in alto, due tocchi e mano spostata per qualsiasi cosa.
 */
function MobileTabBar({ pathname, onMore }: { pathname: string; onMore: () => void }) {
  const tabs: Array<NavItem & { short: string }> = [
    { href: "/dashboard", label: "Home", short: "Home", icon: Home, exact: true },
    { href: "/dashboard/processing", label: "In lavorazione", short: "In corso", icon: Loader },
  ];
  const right: Array<NavItem & { short: string }> = [{ href: "/dashboard/published", label: "Pubblicati", short: "Pubblicati", icon: MonitorPlay }];
  // "Altro" è acceso sulle pagine che stanno solo nel menu (Completati, Feed, Voice over, Facce, Opzioni...).
  const moreActive = ["/dashboard/completed", "/dashboard/feed", "/dashboard/whop", "/dashboard/faces", "/dashboard/settings", "/dashboard/thumbnails", "/dashboard/batch", "/dashboard/credits"].some((h) => pathname.startsWith(h));
  const tab = (item: NavItem & { short: string }) => {
    const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-label={item.label}
        className={`relative flex flex-col items-center justify-center gap-1 pb-1 pt-2 text-[11px] font-semibold transition active:scale-95 ${active ? "text-brand-300" : "text-faint"}`}
      >
        <span className={`absolute top-0 h-[3px] w-6 rounded-b-full bg-brand-400 transition-opacity ${active ? "opacity-100" : "opacity-0"}`} />
        <Icon size={21} strokeWidth={active ? 2.4 : 1.9} />
        {item.short}
      </Link>
    );
  };
  return (
    <nav
      aria-label="Navigazione"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-white/5 bg-canvas/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
    >
      {tabs.map(tab)}
      <div className="flex items-center justify-center">
        <Link
          href="/dashboard#nuovo"
          aria-label="Nuovo progetto"
          className="-mt-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-400 text-on-brand shadow-slab ring-4 ring-canvas transition active:translate-y-[2px] active:shadow-none"
        >
          <Plus size={26} strokeWidth={2.8} />
        </Link>
      </div>
      {right.map(tab)}
      <button
        onClick={onMore}
        className={`relative flex flex-col items-center justify-center gap-1 pb-1 pt-2 text-[11px] font-semibold transition active:scale-95 ${moreActive ? "text-brand-300" : "text-faint"}`}
      >
        <span className={`absolute top-0 h-[3px] w-6 rounded-b-full bg-brand-400 transition-opacity ${moreActive ? "opacity-100" : "opacity-0"}`} />
        <Menu size={21} strokeWidth={moreActive ? 2.4 : 1.9} />
        Altro
      </button>
    </nav>
  );
}

const COLLAPSED_STORAGE_KEY = "clipforge:sidebar-collapsed";

export function DashboardShell({ email, children }: { email: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Preferenza di collasso della sidebar desktop, ricordata tra le sessioni.
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

  function renderNav(iconOnly: boolean) {
    return (
      <nav className="space-y-5">
        {NAV_GROUPS.map((group, i) => (
          <div key={i} className="space-y-0.5">
            {group.title && !iconOnly && <p className="px-3 pb-1 text-xs font-medium text-faint">{group.title}</p>}
            {group.title && iconOnly && <div className="mx-3 mb-2 border-t border-line" />}
            {group.items.map((item) => {
              const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={iconOnly ? item.label : undefined}
                  className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                    isActive ? "bg-white/[0.06] text-white" : "text-muted hover:bg-white/[0.04] hover:text-ink"
                  } ${iconOnly ? "justify-center px-0" : ""}`}
                >
                  {isActive && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand-400" />}
                  <Icon size={18} className={isActive ? "text-brand-300" : "text-faint group-hover:text-muted"} />
                  {!iconOnly && item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    );
  }

  function renderFooter(iconOnly: boolean) {
    return (
      <div className="space-y-2 border-t border-line pt-4">
        <WorkerPauseControl compact={iconOnly} />
        {!iconOnly && <p className="truncate px-3 pt-1 text-xs text-faint">{email}</p>}
        <button
          onClick={handleSignOut}
          title="Esci"
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted transition hover:bg-raised/60 hover:text-ink ${iconOnly ? "justify-center px-0" : ""}`}
        >
          <LogOut size={18} className="text-faint" />
          {!iconOnly && "Esci"}
        </button>
      </div>
    );
  }

  const newProjectButton = (iconOnly: boolean) => (
    <Link href="/dashboard#nuovo" title="Nuovo progetto" className={`btn btn-gradient w-full ${iconOnly ? "px-0" : ""}`}>
      <Plus size={16} />
      {!iconOnly && "Nuovo progetto"}
    </Link>
  );

  return (
    <TooltipProvider>
    <div className="flex min-h-screen">
      {/* Sidebar desktop: espansa o ridotta a sole icone */}
      <aside
        className={`sticky top-0 z-20 hidden h-screen shrink-0 flex-col justify-between border-r border-white/[0.05] bg-canvas p-3 transition-[width] duration-200 md:flex ${
          collapsed ? "w-[68px]" : "w-60"
        }`}
      >
        <div className="space-y-5 overflow-y-auto">
          <div className={`flex items-center pt-1 ${collapsed ? "flex-col gap-3" : "justify-between px-2"}`}>
            <Logo iconOnly={collapsed} />
            <button
              onClick={toggleCollapsed}
              className="rounded-md p-1.5 text-faint transition hover:bg-raised hover:text-ink"
              aria-label={collapsed ? "Espandi menu" : "Riduci menu"}
              title={collapsed ? "Espandi menu" : "Riduci menu"}
            >
              {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </div>
          {newProjectButton(collapsed)}
          {renderNav(collapsed)}
        </div>
        {renderFooter(collapsed)}
      </aside>

      {/* Backdrop + drawer mobile */}
      {mobileOpen && <button aria-label="Chiudi menu" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm md:hidden" />}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col justify-between border-r border-line bg-surface p-3 transition-transform duration-200 md:hidden ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="space-y-5 overflow-y-auto">
          <div className="flex items-center justify-between px-2 pt-1">
            <Logo />
            <button onClick={() => setMobileOpen(false)} className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-ink" aria-label="Chiudi menu">
              <X size={18} />
            </button>
          </div>
          {newProjectButton(false)}
          {renderNav(false)}
        </div>
        {renderFooter(false)}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barra superiore mobile */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-white/5 bg-canvas/75 px-4 py-2.5 backdrop-blur-xl md:hidden">
          <Logo />
        </header>

        {/* Sul telefono la barra in basso copre gli ultimi ~80px: il contenuto finisce sopra. */}
        <main className="min-w-0 flex-1 px-4 pb-28 pt-5 sm:px-6 md:px-10 md:py-10">{children}</main>
        <MobileTabBar pathname={pathname} onMore={() => setMobileOpen(true)} />
      </div>
    </div>
    </TooltipProvider>
  );
}
