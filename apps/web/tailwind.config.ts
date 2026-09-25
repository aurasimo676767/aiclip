import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        // Il sito ha i colori degli Shorts che produce: fondo notte-Twitch, giallo del sottotitolo
        // per le azioni, rosso delle urla per ciò che chiede attenzione, viola Twitch solo per i VOD.
        canvas: "#0d0b12",
        surface: "#15121c",
        raised: "#1d1926",
        overlay: "#262130",
        line: "#2a2534",
        "line-strong": "#3a3446",
        ink: "#f5f3f7",
        muted: "#a9a3b5",
        faint: "#6f687c",
        // "brand" = giallo sottotitolo. Su fondo giallo il testo va scuro (text-on-brand).
        brand: {
          50: "#fffbe0",
          100: "#fff4b3",
          200: "#ffea75",
          300: "#ffe03d",
          400: "#ffd400",
          500: "#f0c200",
          600: "#c99f00",
          700: "#9c7a00",
          800: "#6e5600",
          900: "#3f3100",
        },
        "on-brand": "#1a1400",
        // Rosso urla: live, errori, cose che chiedono attenzione.
        hot: "#ff2d3d",
        twitch: {
          300: "#c4a2ff",
          400: "#a970ff",
          500: "#9146ff",
        },
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 12px 28px -18px rgba(0,0,0,0.8)",
        glow: "0 0 0 1px rgba(255,212,0,0.55), 0 10px 30px -12px rgba(255,212,0,0.35)",
        // Il bordo nero spesso dei sottotitoli, usato come ombra "dura" sui pulsanti principali.
        slab: "0 3px 0 0 #000",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(90deg, #ffd400 0%, #ffe03d 100%)",
      },
      keyframes: {
        shimmer: { "0%": { backgroundPosition: "-200% 0" }, "100%": { backgroundPosition: "200% 0" } },
        "fade-in": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "none" } },
        "overlay-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "dialog-in": {
          from: { opacity: "0", transform: "translateY(10px) scale(0.97)" },
          to: { opacity: "1", transform: "none" },
        },
        "pop-check": { "0%": { transform: "scale(0.4)" }, "60%": { transform: "scale(1.2)" }, "100%": { transform: "scale(1)" } },
        "live-pulse": { "0%, 100%": { opacity: "1" }, "50%": { opacity: "0.35" } },
      },
      animation: {
        shimmer: "shimmer 2.2s linear infinite",
        "fade-in": "fade-in 180ms ease-out",
        "overlay-in": "overlay-in 160ms ease-out",
        "dialog-in": "dialog-in 220ms cubic-bezier(0.2, 0.9, 0.3, 1.1)",
        "pop-check": "pop-check 260ms cubic-bezier(0.2, 0.9, 0.3, 1.4)",
        "live-pulse": "live-pulse 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
