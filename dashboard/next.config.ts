import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /reports was a pre-filtered view of /subscriptions (same client component, same
  // server actions, same table), so it was folded into the aggregate page. The redirect
  // keeps old bookmarks alive and lands them on the Opportunity tab they expected.
  async redirects() {
    return [
      {
        source: "/reports",
        destination: "/subscriptions?kind=opportunity",
        permanent: true,
      },
      // /documents was folded into the Knowledge Base page as its Document
      // Corpus tab (same RAG index, same server actions). The 308 keeps old
      // bookmarks alive and lands them on the corpus tab they expected.
      {
        source: "/documents",
        destination: "/knowledge?tab=corpus",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
