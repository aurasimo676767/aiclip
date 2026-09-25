import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";

// Una sola famiglia: Archivo normale per l'interfaccia, larga e pesantissima (asse wdth) per i
// pochi titoli scritti come un sottotitolo degli Shorts (vedi .type-caption in globals.css).
const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "ClipForge — Shorts e video lunghi dalle tue live",
  description: "Incolla un link: l'AI trova i momenti migliori e li trasforma in Shorts verticali e video long-form pronti da pubblicare.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it" className={archivo.variable}>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
