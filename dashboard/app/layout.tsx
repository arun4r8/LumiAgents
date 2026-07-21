import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";
import "./lumi.css";
import { ThemeProvider } from "@/components/theme-provider";

// Modernist design language: Archivo is the only family — headings and body both.
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "LumiAgents",
  description: "Agent orchestration layer — Lumiture",
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
      className={`${archivo.variable} h-full antialiased`}
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
