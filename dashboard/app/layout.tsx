import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import "./lumi.css";
import { ThemeProvider } from "@/components/theme-provider";

// Nocturne design language: Inter for headings and body, weights 400/500/600
// only (headings never go past 500). The monospace is a system stack — see
// --font-mono in app/lumi.css — so there is no second webfont to download.
// Self-hosted through next/font because this app ships on Cloudflare Workers;
// the Nocturne sheet's @import from fonts.googleapis.com is deliberately unused.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "LumiAgents",
  description: "Agent orchestration layer by Lumiture",
};

// Inline script: reads localStorage before first paint to avoid theme flash
const themeScript = `
(function(){
  try {
    var t = localStorage.getItem('lumi-theme') || 'light';
    var d = localStorage.getItem('lumi-density');
    if (t !== 'system') document.documentElement.setAttribute('data-theme', t);
    if (d === 'compact') document.documentElement.setAttribute('data-density', 'compact');
  } catch(e){}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} h-full antialiased`}
    >
      {/* eslint-disable-next-line react/no-danger */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
