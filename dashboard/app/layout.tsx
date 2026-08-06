import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";
import "./lumi.css";
import { ThemeProvider } from "@/components/theme-provider";

// Archivo for headings and body. The redesign handoff specifies Inter; the product
// owner preferred Archivo, so the typeface stays Archivo while the rest of the
// Nocturne system (colour, spacing, radii, marks) follows the handoff. Weights
// 400/500/600
// only (headings never go past 500). The monospace is a system stack — see
// --font-mono in app/lumi.css — so there is no second webfont to download.
// Self-hosted through next/font because this app ships on Cloudflare Workers;
// the Nocturne sheet's @import from fonts.googleapis.com is deliberately unused.
const archivo = Archivo({
  variable: "--font-archivo",
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
    // No Tailwind utilities here any more: `h-full antialiased` on <html> and
    // `min-h-full` on <body> are now plain rules in app/lumi.css (html/body
    // height; body already declared the font smoothing). The three screens
    // rebuilt in redesign phase 4 carry no utility classes at all.
    <html lang="en" className={archivo.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
