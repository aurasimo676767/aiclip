import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f2f0ff",
          100: "#e6e1ff",
          200: "#c4b8ff",
          300: "#a28fff",
          400: "#8266ff",
          500: "#6b3fff",
          600: "#5726e8",
          700: "#431db5",
          800: "#301582",
          900: "#1d0d52",
        },
      },
    },
  },
  plugins: [],
};

export default config;
