import Link from "next/link";
import { OpportunitiesTab } from "./opportunities";
import { AwardsTab } from "./awards";
import { IndustryDaysTab } from "./industry-days";
import { RfiDraftsTab } from "./rfi-drafts";

export const dynamic = "force-dynamic";

/**
 * BD Pipeline — the redesign's RECORDS domain. Tab state lives in the URL
 * (`?tab=…`) so links deep-link and the old flat routes 308 straight onto the
 * tab they used to be.
 */

// Tab keys are URL-facing and must stay stable for back-compat:
//   ?tab=opportunities → public.opportunities (Beady's GovCon pipeline; moved
//                        here out of /records/data's govcon tab)
//   ?tab=opps          → the `awards` table. Kept as "opps" because /awards
//                        308-redirects to ?tab=opps (next.config.ts); reusing
//                        that key for opportunities would silently land old
//                        links on the wrong data. Labelled "Awards" because
//                        that is the table ./awards.tsx queries.
const TABS = [
  { key: "opportunities", label: "Opportunities" },
  { key: "opps", label: "Awards" },
  { key: "days", label: "Industry days" },
  { key: "rfi", label: "RFI drafts" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function tabFrom(raw: string | undefined): TabKey {
  return raw === "opportunities" || raw === "days" || raw === "rfi" ? raw : "opps";
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

      {active === "opportunities" && <OpportunitiesTab />}
      {active === "opps" && <AwardsTab />}
      {active === "days" && <IndustryDaysTab />}
      {active === "rfi" && <RfiDraftsTab />}
    </>
  );
}
