/**
 * Where an opportunity came from, as a person would say it.
 *
 * `source` alone is too coarse for the board: BD keeps four GovWin exports (Super
 * Swath, VA, State Local, Upcoming Deals) and they mean different things — a
 * state/local row and a federal forecast are not the same lead. So a GovWin row
 * names its export, and everything else names its system.
 */
export interface OpportunitySource {
  source: string | null;
  source_file?: string | null;
}

const SYSTEM: Record<string, string> = {
  sam_gov: "SAM.gov",
  sbir: "SBIR",
  govwin: "GovWin",
  manual: "Manual",
  agent: "Agent",
  govcon_api: "GovCon API",
};

/**
 * "State Local opportunitySearchResults_07-28-2026.xlsx" -> "State Local".
 *
 * GovWin's own export names are `<label> opportunitySearchResults_<date>.xlsx`;
 * BD also renames some by hand ("VA.xlsx"). Strip the boilerplate and the
 * extension and keep what a person actually calls it.
 */
export function exportLabel(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const base = fileName.replace(/\.[a-z0-9]+$/i, "").trim();
  const stripped = base.replace(/\s*opportunitySearchResults.*$/i, "").trim();
  return (stripped || base) || null;
}

/** Short label for the Source column. */
export function sourceLabel(o: OpportunitySource): string {
  const system = SYSTEM[o.source ?? ""] ?? (o.source ? o.source : "Unknown");
  if (o.source !== "govwin") return system;
  const label = exportLabel(o.source_file);
  // A GovWin row imported before source_file existed, and whose link carried no
  // file name, says "GovWin" rather than inventing an export.
  return label ? `${system} · ${label}` : system;
}
