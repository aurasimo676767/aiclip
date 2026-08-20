/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Il worker (rendering pesante) gira separatamente da Vercel: il frontend qui
  // fa solo pagine leggere e API route "sottili" (creazione progetti, signed URL,
  // creazione render job). Vedi apps/worker per la pipeline di elaborazione video.
  // @clipforge/shared e @clipforge/db sono consumati come sorgente TS direttamente dal
  // monorepo (niente build/dist) e usano estensioni ".js" negli import relativi (convenzione
  // NodeNext): il resolver di webpack non le mappa a ".ts" di default, quindi va detto esplicitamente.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
