import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://atalaya-arb.vercel.app"),
  title: "Atalaya · Arbitraje BTC en tiempo real",
  description:
    "Bot de arbitraje de Bitcoin: detección en tiempo real entre 5 exchanges, ejecución simulada en dos fases neta de fees, slippage y latencia. 44 parámetros en runtime, modo caos y laboratorio de estrategias en paralelo.",
  icons: { icon: "/icon.svg" },
  openGraph: {
    title: "Atalaya · Arbitraje BTC en tiempo real",
    description:
      "Detección en vivo entre 5 exchanges · ejecución en dos fases · 44 parámetros en runtime · modo caos · laboratorio de estrategias en paralelo.",
    url: "https://atalaya-arb.vercel.app",
    siteName: "Atalaya",
    locale: "es_MX",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${spaceGrotesk.variable} ${jetBrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
