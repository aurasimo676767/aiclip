import type { Config } from "tailwindcss";

/**
 * App scura "standard", al livello di Opus Clip e CapCut (scelta di simo il 2026-10-26): neutri
 * freddi a gradini, i video sono il colore, UN accento azzurro per selezione e azione principale.
 * I nomi dei token sono rimasti quelli di prima (canvas, surface, brand…) così ogni pagina passa al
 * nuovo look senza riscriverla; cambiano i valori.
 */
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        canvas: "#0b0b0e",
        surface: "#131317",
        raised: "#1a1a1f",
        overlay: "#232329",
        line: "#24242b",
        "line-strong": "#33333c",
        ink: "#f4f4f6",
        muted: "#a2a2ad",
        faint: "#6d6d78",
        // "brand" = l'accento azzurro: azione principale, selezione, stato attivo. Testo sopra: bianco.
        brand: {
          50: "#eef4ff",
          100: "#d9e6ff",
          200: "#b6ceff",
          300: "#86adff",
          400: "#4f86ff",
          500: "#3570f2",
          600: "#2457d6",
          700: "#1d45a8",
          800: "#1b3a82",
          900: "#172f63",
        },
        "on-brand": "#ffffff",
        // Errori e cose che chiedono attenzione.
        hot: "#f2434f",
        good: "#2fd27c",
        warn: "#f5a524",
        twitch: {
          300: "#c4a2ff",
          400: "#a970ff",
          500: "#9146ff",
        },
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.125rem",
        "3xl": "1.5rem",
      },
      boxShadow: {
        // Profondità morbida e fredda (luce dall'alto): mai ombre dure.
        card: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)",
        pop: "0 1px 0 0 rgba(255,255,255,0.06) inset, 0 18px 48px -16px rgba(0,0,0,0.75), 0 2px 8px -2px rgba(0,0,0,0.5)",
        glow: "0 0 0 1px rgba(79,134,255,0.6), 0 8px 24px -10px rgba(79,134,255,0.5)",
        // Il vecchio "slab" (ombra dura nera) diventa un'ombra morbida: chi lo usa ancora non stona.
        slab: "0 6px 16px -6px rgba(53,112,242,0.55)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(90deg, #3570f2 0%, #4f86ff 100%)",
      },
      transitionTimingFunction: {
        out: "cubic-bezier(0.23, 1, 0.32, 1)",
        "in-out": "cubic-bezier(0.77, 0, 0.175, 1)",
        drawer: "cubic-bezier(0.32, 0.72, 0, 1)",
      },
      keyframes: {
        shimmer: { "0%": { backgroundPosition: "-200% 0" }, "100%": { backgroundPosition: "200% 0" } },
        "fade-in": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "none" } },
        "overlay-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "dialog-in": {
          from: { opacity: "0", transform: "translateY(8px) scale(0.97)" },
          to: { opacity: "1", transform: "none" },
        },
        "sheet-in": { from: { transform: "translateY(100%)" }, to: { transform: "none" } },
        "pop-check": { "0%": { transform: "scale(0.6)", opacity: "0" }, "100%": { transform: "scale(1)", opacity: "1" } },
        "live-pulse": { "0%, 100%": { opacity: "1" }, "50%": { opacity: "0.4" } },
        "progress-stripes": { from: { backgroundPosition: "0 0" }, to: { backgroundPosition: "28px 0" } },
      },
      animation: {
        shimmer: "shimmer 2s linear infinite",
        "fade-in": "fade-in 240ms cubic-bezier(0.23, 1, 0.32, 1) both",
        "overlay-in": "overlay-in 200ms cubic-bezier(0.23, 1, 0.32, 1)",
        "dialog-in": "dialog-in 240ms cubic-bezier(0.23, 1, 0.32, 1)",
        "sheet-in": "sheet-in 320ms cubic-bezier(0.32, 0.72, 0, 1)",
        "pop-check": "pop-check 200ms cubic-bezier(0.23, 1, 0.32, 1)",
        "live-pulse": "live-pulse 1.6s ease-in-out infinite",
        "progress-stripes": "progress-stripes 900ms linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
