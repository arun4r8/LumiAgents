import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every route the redesign moved keeps a permanent (308) redirect — teammates
  // have these bookmarked and several are pasted into runbooks.
  async redirects() {
    return [
      // ── pre-redesign consolidations (kept) ────────────────────────────────
      // /reports was a pre-filtered view of /subscriptions; /subscriptions has
      // since folded into Settings, so this lands two hops in, in one hop.
      {
        source: "/reports",
        destination: "/settings?tab=subscriptions&kind=opportunity",
        permanent: true,
      },
      // /documents was folded into the Knowledge Base page as its Document
      // Corpus tab (same RAG index, same server actions).
      {
        source: "/documents",
        destination: "/knowledge?tab=corpus",
        permanent: true,
      },
      // Ask Data (natural-language SQL) is a tab on the Data records screen,
      // which phase 2 moved under /records.
      {
        source: "/analyst",
        destination: "/records/data?tab=ask",
        permanent: true,
      },

      // ── redesign phase 2: the RECORDS domain ──────────────────────────────
      // Awards, Industry Days and RFI Drafts are now tabs on BD Pipeline; each
      // old route lands on the tab it used to be.
      { source: "/awards", destination: "/records/bd?tab=opps", permanent: true },
      { source: "/industry-days", destination: "/records/bd?tab=days", permanent: true },
      { source: "/rfi-drafts", destination: "/records/bd?tab=rfi", permanent: true },
      { source: "/content-calendar", destination: "/records/content", permanent: true },
      { source: "/data", destination: "/records/data", permanent: true },
      // Bare /records has never been a screen; send it to the domain's first tab.
      { source: "/records", destination: "/records/bd?tab=opps", permanent: true },

      // ── redesign phase 2: subscriptions folds under Settings ──────────────
      { source: "/subscriptions", destination: "/settings?tab=subscriptions", permanent: true },
    ];
  },
};

export default nextConfig;
