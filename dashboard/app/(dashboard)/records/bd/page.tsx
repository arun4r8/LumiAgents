import Link from "next/link";
import { OpportunitiesTab } from "./opportunities";
import { IndustryDaysTab } from "./industry-days";
import { RfiDraftsTab } from "./rfi-drafts";

export const dynamic = "force-dynamic";

/**
 * BD Pipeline — the redesign's RECORDS domain merges three formerly separate
 * routes (/awards, /industry-days, /rfi-drafts) behind one page with a
 * segmented control. Tab state lives in the URL (`?tab=rfi`) so links deep-link
 * and the old routes can 308 straight onto the tab they used to be.
 *
 * Phase 2 relocates and re-shells only: each tab renders its previous page body
 * unchanged (including that body's own page header). Phase 6 rebuilds the
 * records table shell itself.
 */

// NOTE: the `opps` key is kept for URL back-compat (/awards redirects to ?tab=opps).
// The label says "Awards" because that is what this tab renders — the awards table.
// The design handoff calls this tab "Opportunities"; there is no Opportunities screen
// yet (the opportunities table has no UI), so the label matches the content until one
// exists rather than promising something the page does not show.
const TABS = [
  { key: "opps", label: "Awards" },
  { key: "days", label: "Industry days" },
  { key: "rfi", label: "RFI drafts" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function tabFrom(raw: string | undefined): TabKey {
  return raw === "days" || raw === "rfi" ? raw : "opps";
}

export default async function BdPipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const active = tabFrom(tab);

  return (
    <>
      <div className="page" style={{ paddingBottom: 0 }}>
        <div className="records-seg" role="tablist" aria-label="BD pipeline">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={`/records/bd?tab=${t.key}`}
              role="tab"
              aria-selected={active === t.key}
              className={`records-seg-opt${active === t.key ? " active" : ""}`}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>

      {active === "opps" && <OpportunitiesTab />}
      {active === "days" && <IndustryDaysTab />}
      {active === "rfi" && <RfiDraftsTab />}
    </>
  );
}
