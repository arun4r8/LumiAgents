import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./lumi.css";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
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
