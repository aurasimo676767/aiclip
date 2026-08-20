import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipForge — YouTube Shorts automatici dai tuoi video",
  description: "Carica un video lungo, ottieni Shorts verticali pronti da pubblicare, generati automaticamente dall'AI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body className="min-h-screen bg-[#0b0a12] font-sans antialiased">{children}</body>
    </html>
  );
}
