import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "ui-sans-serif", "sans-serif"],
      },
      colors: {
        // Superfici: dal fondo pagina (canvas) alle card (surface) agli elementi sopra le card (raised).
        canvas: "#08080b",
        surface: "#111116",
        raised: "#191920",
        overlay: "#22222b",
        line: "#26262f",
        "line-strong": "#34343f",
        ink: "#f4f4f6",
        muted: "#a3a3b0",
        faint: "#6c6c7a",
        brand: {
          50: "#f3f0ff",
          100: "#e7e0ff",
          200: "#cdbdff",
          300: "#ae96ff",
          400: "#9173ff",
          500: "#7c5cff",
          600: "#6841f0",
          700: "#5431c4",
          800: "#3c2390",
          900: "#241558",
        },
        hot: "#ff5ca8",
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.6)",
        glow: "0 0 0 1px rgba(124,92,255,0.5), 0 8px 32px -8px rgba(124,92,255,0.45)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #7c5cff 0%, #b35cff 50%, #ff5ca8 100%)",
      },
      keyframes: {
        shimmer: { "0%": { backgroundPosition: "-200% 0" }, "100%": { backgroundPosition: "200% 0" } },
        "fade-in": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "none" } },
      },
      animation: {
        shimmer: "shimmer 2.2s linear infinite",
        "fade-in": "fade-in 180ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
