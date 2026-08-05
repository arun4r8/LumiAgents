"use client";

import { useState, useRef } from "react";
import { AskDataPanel } from "./ask-data-panel";
import {
  Plus, Upload, X, ChevronDown, ChevronUp,
  Check, Loader2, AlertTriangle, ExternalLink, Star,
  User, Send, Download,
} from "lucide-react";
import * as XLSX from "xlsx";

// ─── Field config ─────────────────────────────────────────────────────────────

type FieldType = "text" | "email" | "number" | "currency" | "date" | "select" | "uuid-ref";

interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];       // for select
  placeholder?: string;
  tableCol?: boolean;       // show in the table view (default true)
}

// ─── Table configs ────────────────────────────────────────────────────────────

const CONTRACTS_FIELDS: Field[] = [
  { key: "contract_number",  label: "Contract #",    type: "text",     required: true,  tableCol: true },
  { key: "task_order_number",label: "Task Order #",  type: "text",     tableCol: true },
  { key: "client_name",      label: "Client",        type: "text",     required: true,  tableCol: true },
  { key: "client_agency",    label: "Agency",        type: "text",     required: true,  tableCol: true },
  { key: "vehicle",          label: "Vehicle",       type: "text",     tableCol: true },
  { key: "contract_type",    label: "Type",          type: "select",   options: ["FFP","T&M","CPFF","CPIF","IDIQ","BPA"] },
  { key: "set_aside",        label: "Set-aside",     type: "select",   options: ["None","SDVOSB","WOSB","8(a)","HUBZone","VOSB","SB"] },
  { key: "total_value",      label: "Total Value",   type: "currency", tableCol: true },
  { key: "obligated_value",  label: "Obligated",     type: "currency" },
  { key: "option_years",     label: "Option Years",  type: "number" },
  { key: "pop_start",        label: "PoP Start",     type: "date" },
  { key: "pop_end",          label: "PoP End",       type: "date" },
  { key: "status",           label: "Status",        type: "select",   options: ["active","option","completed","terminated"], tableCol: true },
];

const INVOICES_FIELDS: Field[] = [
  { key: "client_name",    label: "Client",          type: "text",     required: true, tableCol: true },
  { key: "client_agency",  label: "Agency",          type: "text",     tableCol: true },
  { key: "contract_id",    label: "Contract ID",     type: "uuid-ref", placeholder: "UUID of contract row" },
  { key: "amount",         label: "Amount",          type: "currency", required: true, tableCol: true },
  { key: "amount_paid",    label: "Paid",            type: "currency", tableCol: true },
  { key: "invoice_date",   label: "Invoice Date",    type: "date",     required: true, tableCol: true },
  { key: "due_date",       label: "Due Date",        type: "date" },
  { key: "paid_date",      label: "Paid Date",       type: "date" },
  { key: "status",         label: "Status",          type: "select",   options: ["draft","submitted","approved","paid","overdue","disputed"], tableCol: true },
  { key: "billing_period", label: "Billing Period",  type: "text",     placeholder: "e.g. Oct 2025" },
];

const BUDGET_LINES_FIELDS: Field[] = [
  { key: "contract_id",  label: "Contract ID", type: "uuid-ref", required: true },
  { key: "clin",         label: "CLIN",        type: "text",     required: true, tableCol: true },
  { key: "description",  label: "Description", type: "text",     tableCol: true },
  { key: "category",     label: "Category",    type: "select",   options: ["Labor","ODC","Travel","Materials","Subcontract"], tableCol: true },
  { key: "fiscal_year",  label: "FY",          type: "number",   tableCol: true },
  { key: "budgeted",     label: "Budgeted",    type: "currency", tableCol: true },
  { key: "obligated",    label: "Obligated",   type: "currency", tableCol: true },
  { key: "expended",     label: "Expended",    type: "currency" },
  { key: "remaining",    label: "Remaining",   type: "currency" },
  { key: "notes",        label: "Notes",       type: "text" },
];

const LABOR_RECORDS_FIELDS: Field[] = [
  { key: "employee_name",   label: "Employee",       type: "text",     required: true, tableCol: true },
  { key: "contract_number", label: "Contract #",     type: "text",     required: true, tableCol: true },
  { key: "clin",            label: "CLIN",           type: "text",     tableCol: true },
  { key: "work_date",       label: "Date",           type: "date",     required: true, tableCol: true },
  { key: "hours",           label: "Hours",          type: "number",   required: true, tableCol: true },
  { key: "labor_category",  label: "Labor Category", type: "text",     tableCol: true },
  { key: "hourly_rate",     label: "Rate/hr",        type: "currency" },
  { key: "charge_type",     label: "Charge Type",    type: "select",   options: ["direct","indirect","overhead","unallowable"], tableCol: true },
];

const INDIRECT_RATES_FIELDS: Field[] = [
  { key: "fiscal_year",    label: "FY",           type: "number",   required: true, tableCol: true },
  { key: "rate_type",      label: "Rate Type",    type: "select",   options: ["Fringe","Overhead","G&A","COM","SubK"], required: true, tableCol: true },
  { key: "rate_basis",     label: "Basis",        type: "text",     tableCol: true },
  { key: "rate_pct",       label: "Rate %",       type: "number",   required: true, tableCol: true },
  { key: "approved_date",  label: "Approved",     type: "date" },
  { key: "effective_from", label: "Effective From", type: "date",   tableCol: true },
  { key: "effective_to",   label: "Effective To",   type: "date",   tableCol: true },
];

const EMPLOYEES_FIELDS: Field[] = [
  { key: "full_name",        label: "Name",            type: "text",   required: true, tableCol: true },
  { key: "email",            label: "Email",           type: "email",  required: true, tableCol: true },
  { key: "title",            label: "Title",           type: "text",   tableCol: true },
  { key: "department",       label: "Department",      type: "select", options: ["Engineering","BD","Finance","HR","Operations","Legal","Contracts"], tableCol: true },
  { key: "employment_type",  label: "Type",            type: "select", options: ["FTE","contractor","part-time"], tableCol: true },
  { key: "clearance_level",  label: "Clearance",       type: "select", options: ["None","Public Trust","Secret","Top Secret","TS/SCI"], tableCol: true },
  { key: "status",           label: "Status",          type: "select", options: ["active","inactive","terminated"], tableCol: true },
  { key: "start_date",       label: "Start Date",      type: "date" },
  { key: "end_date",         label: "End Date",        type: "date" },
];

const PAST_PERF_FIELDS: Field[] = [
  { key: "title",       label: "Project Title",  type: "text",     required: true, tableCol: true },
  { key: "customer",    label: "Customer",       type: "text",     required: true, tableCol: true },
  { key: "domain",      label: "Domain",         type: "select",   options: ["IT","Cybersecurity","Finance","HR","Engineering","Other"], tableCol: true },
  { key: "scope_summary", label: "Scope",        type: "text",     tableCol: true },
  { key: "contract_value",label: "Value",        type: "text",     tableCol: true },
  { key: "period_of_performance", label: "PoP", type: "text" },
];

// ─── Section config ───────────────────────────────────────────────────────────

interface SectionDef {
  id: string;
  label: string;
  description: string;
  tableName: string;
  fields: Field[];
  readOnly?: boolean;
  readOnlyNote?: string;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface DataClientProps {
  contracts: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  budgetLines: Record<string, unknown>[];
  laborRecords: Record<string, unknown>[];
  indirectRates: Record<string, unknown>[];
  employees: Record<string, unknown>[];
  pastPerformance: Record<string, unknown>[];
  opportunities: Record<string, unknown>[];
  candidates: Record<string, unknown>[];
  staffRequests: Record<string, unknown>[];
  resumeJobs: Record<string, unknown>[];
  resumeResults: Record<string, unknown>[];
  insertRow: (table: string, data: Record<string, unknown>) => Promise<{ error?: string }>;
  bulkInsert: (table: string, rows: Record<string, unknown>[]) => Promise<{ inserted: number; error?: string }>;
  deleteRow: (table: string, id: string) => Promise<{ error?: string }>;
  initialTab?: "govcon" | "finance" | "people" | "ask";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DataClient({
  contracts, invoices, budgetLines, laborRecords, indirectRates,
  employees, pastPerformance, opportunities, candidates, staffRequests,
  resumeJobs, resumeResults,
  insertRow, bulkInsert, deleteRow, initialTab,
}: DataClientProps) {
  const [tab, setTab] = useState<"govcon" | "finance" | "people" | "ask">(initialTab ?? "govcon");

  const govconSections: SectionDef[] = [
    {
      id: "contracts", label: "Contracts", tableName: "contracts",
      description: "Live contract portfolio",
      fields: CONTRACTS_FIELDS,
    },
    {
      id: "past_performance", label: "Past Performance", tableName: "past_performance",
      description: "Capability statements and PPQs used in proposal scoring",
      fields: PAST_PERF_FIELDS,
    },
  ];

  const financeSections: SectionDef[] = [
    {
      id: "invoices", label: "Invoices", tableName: "invoices",
      description: "Billing records and payment status",
      fields: INVOICES_FIELDS,
    },
    {
      id: "budget_lines", label: "Budget Lines", tableName: "budget_lines",
      description: "CLIN-level budget tracking per contract",
      fields: BUDGET_LINES_FIELDS,
    },
    {
      id: "labor_records", label: "Labor Records", tableName: "labor_records",
      description: "Timesheet and charge-hour data",
      fields: LABOR_RECORDS_FIELDS,
    },
    {
      id: "indirect_rates", label: "Indirect Rates", tableName: "indirect_rates",
      description: "Fringe / OH / G&A rates by fiscal year",
      fields: INDIRECT_RATES_FIELDS,
    },
  ];

  const peopleSections: SectionDef[] = [
    {
      id: "employees", label: "Employees", tableName: "employees",
      description: "Staff directory",
      fields: EMPLOYEES_FIELDS,
    },
  ];

  const activeSections =
    tab === "govcon" ? govconSections :
    tab === "finance" ? financeSections :
    peopleSections;

  const dataMap: Record<string, Record<string, unknown>[]> = {
    contracts, invoices, budget_lines: budgetLines, labor_records: laborRecords,
    indirect_rates: indirectRates, employees, past_performance: pastPerformance,
    opportunities, candidates,
  };

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1>Records</h1>
          <div className="sub">Business records. Two ways in: manual entry or CSV import.</div>
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 24 }}>
        <button className={tab === "govcon" ? "active" : ""} onClick={() => setTab("govcon")}>
          GovCon
          <span className="count" style={{ marginLeft: 6 }}>{opportunities.length + contracts.length + pastPerformance.length}</span>
        </button>
        <button className={tab === "finance" ? "active" : ""} onClick={() => setTab("finance")}>
          Finance
          <span className="count" style={{ marginLeft: 6 }}>{invoices.length + budgetLines.length + laborRecords.length + indirectRates.length}</span>
        </button>
        <button className={tab === "people" ? "active" : ""} onClick={() => setTab("people")}>
          People
          <span className="count" style={{ marginLeft: 6 }}>{candidates.length + staffRequests.length + employees.length + resumeResults.length}</span>
        </button>
        <button className={tab === "ask" ? "active" : ""} onClick={() => setTab("ask")}>
          Ask Data
        </button>
      </div>

      {tab === "ask" && <AskDataPanel />}

      {tab === "govcon" && <OpportunitiesPanel opportunities={opportunities} />}
      {tab === "people" && (
        <>
          <ResumeResultsPanel resumeJobs={resumeJobs} resumeResults={resumeResults} />
          <CandidatesPanel candidates={candidates} />
          <StaffRequestsPanel staffRequests={staffRequests} />
        </>
      )}

      {tab !== "ask" && activeSections.map((section) => (
        <TableSection
          key={section.id}
          section={section}
          rows={dataMap[section.tableName] ?? []}
          insertRow={insertRow}
          bulkInsert={bulkInsert}
          deleteRow={deleteRow}
        />
      ))}
    </div>
  );
}

// ─── Score badge ──────────────────────────────────────────────────────────────

function ScoreBadge({ score, max = 10 }: { score: unknown; max?: number }) {
  if (score == null) return <span style={{ color: "var(--ink-3)", fontSize: 12 }}>-</span>;
  const n = Number(score);
  const color = n >= 7 ? "var(--ok)" : n >= 4 ? "var(--warn, #f59e0b)" : "var(--err)";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      fontWeight: 600, fontSize: 13, color,
    }}>
      <Star style={{ width: 11, height: 11, fill: color, stroke: "none" }} />
      {n}/{max}
    </span>
  );
}

// ─── Opportunities panel ──────────────────────────────────────────────────────

function OpportunitiesPanel({ opportunities }: { opportunities: Record<string, unknown>[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div style={{ marginBottom: 28 }}>
      <div className="section-h">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3>Opportunities</h3>
          <span className="chip muted" style={{ fontSize: 11 }}>{opportunities.length}</span>
          <span className="chip accent" style={{ fontSize: 11 }}>beady</span>
        </div>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Written by beady/opportunity-sweep</span>
      </div>

      {opportunities.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--ink-3)", padding: "16px 0" }}>
          No opportunities yet. Run <code className="mono" style={{ fontSize: 12 }}>beady/opportunity-sweep</code> to populate.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {opportunities.map((opp) => {
            const id = opp.id as string;
            const name = (opp.opportunity_name as string | null) ?? "Untitled";
            const agency = opp.agency as string | null;
            const setAside = opp.set_aside as string | null;
            const naics = opp.naics_codes != null ? String(opp.naics_codes).slice(0, 30) : null;
            const rec = opp.recommendation as string | null;
            const recColor = rec === "pursue" ? "ok" : rec === "monitor" ? "warn" : rec === "pass" ? "err" : "muted";
            const dueDate = opp.response_due_date as string | null;
            const fitReason = opp.fit_reason as string | null;
            const redFlags = opp.red_flags as string | null;
            const solNum = opp.solicitation_number as string | null;
            const scoredAt = opp.last_scored_at as string | null;
            const status = opp.status as string | null;
            const isOpen = expanded === id;
            return (
              <div key={id} className="card" style={{ padding: "12px 16px" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12, cursor: "pointer" }}
                     onClick={() => setExpanded(isOpen ? null : id)}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {name}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                      {agency && <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{agency}</span>}
                      {setAside && <span className="chip muted" style={{ fontSize: 10.5 }}>{setAside}</span>}
                      {naics && <span className="chip muted mono" style={{ fontSize: 10.5 }}>{naics}</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                    <ScoreBadge score={opp.fit_score} />
                    {rec && <span className={`chip ${recColor}`} style={{ fontSize: 11 }}>{rec}</span>}
                    {dueDate && (
                      <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                        Due {new Date(dueDate).toLocaleDateString()}
                      </span>
                    )}
                    {isOpen ? <ChevronUp style={{ width: 14, height: 14, color: "var(--ink-3)" }} />
                             : <ChevronDown style={{ width: 14, height: 14, color: "var(--ink-3)" }} />}
                  </div>
                </div>
                {isOpen && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 8 }}>
                    {fitReason && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>Fit rationale</div>
                        <div style={{ fontSize: 13, color: "var(--ink-1)" }}>{fitReason}</div>
                      </div>
                    )}
                    {redFlags && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--err)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>Red flags</div>
                        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>{redFlags}</div>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--ink-3)" }}>
                      {solNum && <span>Solicitation: <code className="mono">{solNum}</code></span>}
                      {scoredAt && <span>Scored {new Date(scoredAt).toLocaleDateString()}</span>}
                      {status && <span>Status: {status}</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Resume results panel ─────────────────────────────────────────────────────

function downloadJobXlsx(job: Record<string, unknown>, results: Record<string, unknown>[]) {
  const rows = results.map((r) => ({
    "Name":                      r.name ?? "",
    "Email":                     r.email ?? "",
    "Phone":                     r.mobile_number ?? "",
    "Location":                  r.location ?? "",
    "School":                    r.school ?? "",
    "Field of Study":            r.field_of_study ?? "",
    "GPA":                       r.gpa ?? "",
    "Grad Year":                 r.grad_year ?? "",
    "Role":                      r.role ?? "",
    "Technical Skills":          r.technical_skills_score ?? "",
    "Work Experience":           r.work_experience_score ?? "",
    "Academics":                 r.academics_score ?? "",
    "Projects & Research":       r.projects_and_research_score ?? "",
    "Leadership & Initiative":   r.leadership_and_initiative_score ?? "",
    "Overall Score":             r.overall_score ?? "",
    "Rationale":                 r.rationale ?? "",
    "Status":                    r.status ?? "",
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  // Auto-width columns
  const colWidths = Object.keys(rows[0] ?? {}).map((k) => ({
    wch: Math.max(k.length, ...rows.map((r) => String(r[k as keyof typeof r] ?? "").length).slice(0, 50)) + 2,
  }));
  ws["!cols"] = colWidths;

  const wb = XLSX.utils.book_new();
  const jobLabel = String(job.job ?? "results").slice(0, 28).replace(/[^\w\s-]/g, "");
  XLSX.utils.book_append_sheet(wb, ws, "Results");
  XLSX.writeFile(wb, `resume-results-${jobLabel}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function ResumeResultsPanel({
  resumeJobs, resumeResults,
}: { resumeJobs: Record<string, unknown>[]; resumeResults: Record<string, unknown>[] }) {
  const resultsByJob = new Map<string, Record<string, unknown>[]>();
  for (const r of resumeResults) {
    const jid = r.job_id as string;
    if (!resultsByJob.has(jid)) resultsByJob.set(jid, []);
    resultsByJob.get(jid)!.push(r);
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <div className="section-h">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3>Resume Scoring Results</h3>
          <span className="chip muted" style={{ fontSize: 11 }}>{resumeResults.length}</span>
          <span className="chip accent" style={{ fontSize: 11 }}>angie</span>
        </div>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Written by n8n resume-scoring workflow</span>
      </div>

      {resumeJobs.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--ink-3)", padding: "16px 0" }}>
          No scoring jobs yet. Ask Angie to score résumés to populate.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {resumeJobs.map((job) => {
            const jid = job.id as string;
            const jobResults = resultsByJob.get(jid) ?? [];
            const total = job.total as number ?? 0;
            const processed = job.processed as number ?? 0;
            const status = job.status as string ?? "queued";
            const statusColor = status === "done" ? "ok" : status === "queued" ? "muted" : "warn";
            const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
            const jobDesc = String(job.job ?? "").slice(0, 80);
            const createdAt = job.created_at as string;

            return (
              <div key={jid} className="card" style={{ padding: "12px 16px" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {jobDesc || "Untitled job"}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 12, color: "var(--ink-3)" }}>
                      <span className={`chip ${statusColor}`} style={{ fontSize: 11 }}>{status}</span>
                      <span>{processed}/{total} scored ({pct}%)</span>
                      {jobResults.length > 0 && (
                        <span>{jobResults.length} result{jobResults.length !== 1 ? "s" : ""} loaded</span>
                      )}
                      {createdAt && <span>{new Date(createdAt).toLocaleDateString()}</span>}
                    </div>
                  </div>
                  <button
                    className="btn sm"
                    style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 5 }}
                    disabled={jobResults.length === 0}
                    onClick={() => downloadJobXlsx(job, jobResults)}
                    title={jobResults.length === 0 ? "No results loaded for this job yet" : `Download ${jobResults.length} results as XLSX`}
                  >
                    <Download style={{ width: 12, height: 12 }} />
                    Download XLSX
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Candidates panel ──────────────────────────────────────────────────────────

function CandidatesPanel({ candidates }: { candidates: Record<string, unknown>[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "shortlisted" | "pending">("all");

  const filtered = candidates.filter((c) => {
    if (filter === "shortlisted") return c.status === "shortlisted" || Number(c.match_score) >= 7;
    if (filter === "pending") return c.status === "sourced" || c.status === "reviewing";
    return true;
  });

  return (
    <div style={{ marginBottom: 28 }}>
      <div className="section-h">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3>Candidates</h3>
          <span className="chip muted" style={{ fontSize: 11 }}>{candidates.length}</span>
          <span className="chip accent" style={{ fontSize: 11 }}>angie</span>
        </div>
        <div className="row gap-sm">
          {(["all", "shortlisted", "pending"] as const).map((f) => (
            <button key={f} className={`btn sm${filter === f ? " accent" : ""}`} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>

      {candidates.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--ink-3)", padding: "16px 0" }}>
          No candidates yet. Run <code className="mono" style={{ fontSize: 12 }}>angie/candidate-sourcing</code> to populate.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((c) => {
            const id = c.id as string;
            const isOpen = expanded === id;
            const displayName = (c.name as string | null)
              ?? (`${String(c.first_name ?? "")} ${String(c.last_name ?? "")}`.trim() || "Unknown");
            const currentTitle = c.current_title as string | null;
            const currentCompany = c.current_company as string | null;
            const role = c.role as string | null;
            const subtitle = currentTitle
              ? `${currentTitle}${currentCompany ? ` @ ${currentCompany}` : ""}`
              : (role ?? "");
            const status = c.status as string | null;
            const statusColor = status === "shortlisted" ? "ok" : status === "rejected" ? "err" : status === "hired" ? "accent" : "muted";
            const linkedinUrl = c.linkedin_url as string | null;
            const matchReason = c.match_reason as string | null;
            const email = c.email as string | null;
            const location = c.location as string | null;
            const seniority = c.seniority as string | null;
            const source = c.source as string | null;
            return (
              <div key={id} className="card" style={{ padding: "12px 16px" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12, cursor: "pointer" }}
                     onClick={() => setExpanded(isOpen ? null : id)}>
                  <div style={{
                    width: 34, height: 34, borderRadius: "50%", background: "var(--bg-2)",
                    border: "1px solid var(--line)", display: "flex", alignItems: "center",
                    justifyContent: "center", flexShrink: 0,
                  }}>
                    <User style={{ width: 15, height: 15, color: "var(--ink-3)" }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{displayName}</div>
                    {subtitle && <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2 }}>{subtitle}</div>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <ScoreBadge score={c.match_score} />
                    {status && <span className={`chip ${statusColor}`} style={{ fontSize: 11 }}>{status}</span>}
                    {c.outreach_sent === true && (
                      <span title="Outreach sent" style={{ display: "flex", color: "var(--ok)" }}>
                        <Send style={{ width: 12, height: 12 }} />
                      </span>
                    )}
                    {linkedinUrl && (
                      <a href={linkedinUrl} target="_blank" rel="noreferrer"
                         onClick={(e) => e.stopPropagation()}
                         style={{ color: "var(--ink-3)", display: "flex" }}>
                        <ExternalLink style={{ width: 12, height: 12 }} />
                      </a>
                    )}
                    {isOpen ? <ChevronUp style={{ width: 14, height: 14, color: "var(--ink-3)" }} />
                             : <ChevronDown style={{ width: 14, height: 14, color: "var(--ink-3)" }} />}
                  </div>
                </div>
                {isOpen && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 8 }}>
                    {matchReason && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>Match rationale</div>
                        <div style={{ fontSize: 13, color: "var(--ink-1)" }}>{matchReason}</div>
                      </div>
                    )}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12, color: "var(--ink-3)" }}>
                      {email && <span>{email}</span>}
                      {location && <span>{location}</span>}
                      {seniority && <span className="chip muted" style={{ fontSize: 11 }}>{seniority}</span>}
                      {source && <span className="chip" style={{ fontSize: 11 }}>{source}</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--ink-3)", padding: "12px 0" }}>No candidates match this filter.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Staff requests panel ─────────────────────────────────────────────────────

function StaffRequestsPanel({ staffRequests }: { staffRequests: Record<string, unknown>[] }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div className="section-h">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3>Staff Requests</h3>
          <span className="chip muted" style={{ fontSize: 11 }}>{staffRequests.length}</span>
          <span className="chip accent" style={{ fontSize: 11 }}>patch</span>
        </div>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Written by patch/staff-request</span>
      </div>

      {staffRequests.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--ink-3)", padding: "16px 0" }}>
          No staff requests yet. Run <code className="mono" style={{ fontSize: 12 }}>patch/staff-request</code> to populate.
        </div>
      ) : (
        <div className="card" style={{ overflow: "auto", marginBottom: 4 }}>
          <table className="tbl" style={{ minWidth: 850 }}>
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Urgency</th>
                <th>Status</th>
                <th>Requested by</th>
                <th>Jira</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {staffRequests.map((r, i) => {
                const urgency = r.urgency as string | null;
                const urgColor = urgency === "critical" ? "err" : urgency === "high" ? "warn" : "muted";
                const status = r.status as string | null;
                const stColor = status === "fulfilled" ? "ok" : status === "open" ? "accent" : "muted";
                return (
                  <tr key={(r.id as string) ?? i}>
                    <td style={{ fontWeight: 500 }}>{(r.title as string) ?? "-"}</td>
                    <td><span className="chip muted" style={{ fontSize: 11 }}>{(r.request_type as string) ?? "-"}</span></td>
                    <td>{urgency && <span className={`chip ${urgColor}`} style={{ fontSize: 11 }}>{urgency}</span>}</td>
                    <td>{status && <span className={`chip ${stColor}`} style={{ fontSize: 11 }}>{status}</span>}</td>
                    <td style={{ fontSize: 12.5 }}>{(r.requested_by as string) ?? "-"}</td>
                    <td>
                      {r.jira_key ? (
                        <span className="mono chip" style={{ fontSize: 11 }}>{r.jira_key as string}</span>
                      ) : <span style={{ color: "var(--ink-3)" }}>-</span>}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {r.created_at ? new Date(r.created_at as string).toLocaleDateString() : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Editable section ─────────────────────────────────────────────────────────

function TableSection({
  section, rows, insertRow, bulkInsert, deleteRow,
}: {
  section: SectionDef;
  rows: Record<string, unknown>[];
  insertRow: DataClientProps["insertRow"];
  bulkInsert: DataClientProps["bulkInsert"];
  deleteRow: DataClientProps["deleteRow"];
}) {
  const [mode, setMode] = useState<"view" | "add" | "csv">("view");

  const tableCols = section.fields.filter((f) => f.tableCol !== false).map((f) => f.key);

  return (
    <div style={{ marginBottom: 32 }}>
      <div className="section-h">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3>{section.label}</h3>
          <span className="chip muted" style={{ fontSize: 11 }}>{rows.length}</span>
        </div>
        <div className="row gap-sm">
          <button
            className={`btn sm${mode === "add" ? " accent" : ""}`}
            onClick={() => setMode(mode === "add" ? "view" : "add")}
          >
            <Plus style={{ width: 12, height: 12 }} /> Add row
          </button>
          <button
            className={`btn sm${mode === "csv" ? " accent" : ""}`}
            onClick={() => setMode(mode === "csv" ? "view" : "csv")}
          >
            <Upload style={{ width: 12, height: 12 }} /> Import CSV
          </button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>{section.description}</div>

      {mode === "add" && (
        <AddRowPanel
          fields={section.fields}
          tableName={section.tableName}
          insertRow={insertRow}
          onDone={() => setMode("view")}
        />
      )}

      {mode === "csv" && (
        <CsvImportPanel
          fields={section.fields}
          tableName={section.tableName}
          bulkInsert={bulkInsert}
          onDone={() => setMode("view")}
        />
      )}

      {rows.length === 0 ? (
        <div className="empty" style={{ padding: "32px 0" }}>
          <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
            No records yet. Add rows manually or import a CSV.
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflow: "auto" }}>
          <DataTable rows={rows} columns={tableCols} onDelete={(id) => deleteRow(section.tableName, id)} />
        </div>
      )}
    </div>
  );
}

// ─── Data table ───────────────────────────────────────────────────────────────

function DataTable({
  rows, columns, onDelete,
}: {
  rows: Record<string, unknown>[];
  columns: string[];
  onDelete?: (id: string) => Promise<{ error?: string }>;
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDelete(id: string) {
    if (!onDelete) return;
    setDeletingId(id);
    await onDelete(id);
    setDeletingId(null);
  }

  return (
    <table className="tbl" style={{ minWidth: columns.length * 160 + (onDelete ? 44 : 0) }}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col}>{col.replace(/_/g, " ")}</th>
          ))}
          {onDelete && <th style={{ width: 32 }} />}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={(row.id as string) ?? i}>
            {columns.map((col) => (
              <td key={col}>
                <CellValue value={row[col]} col={col} />
              </td>
            ))}
            {onDelete && (
              <td>
                <button
                  className="btn ghost sm"
                  style={{ padding: "2px 6px", color: "var(--ink-3)" }}
                  onClick={() => handleDelete(row.id as string)}
                  disabled={deletingId === (row.id as string)}
                  title="Delete row"
                >
                  {deletingId === row.id
                    ? <Loader2 style={{ width: 11, height: 11, animation: "spin 1s linear infinite" }} />
                    : <X style={{ width: 11, height: 11 }} />}
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CellValue({ value, col }: { value: unknown; col: string }) {
  if (value == null) return <span style={{ color: "var(--ink-3)" }}>-</span>;
  const s = String(value);

  if (col.includes("value") || col.includes("amount") || col.includes("budgeted") ||
      col.includes("obligated") || col.includes("expended") || col.includes("rate")) {
    const n = Number(value);
    if (!isNaN(n) && n > 0) {
      return <span className="mono">${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>;
    }
  }
  if (col === "status" || col === "recommendation") {
    const tone = s === "active" || s === "paid" || s === "pursue" ? "ok"
      : s === "completed" ? "muted"
      : s === "overdue" || s === "terminated" || s === "pass" ? "err"
      : s === "monitor" ? "warn"
      : "";
    return <span className={`chip${tone ? ` ${tone}` : ""}`} style={{ fontSize: 11 }}>{s}</span>;
  }
  if (col.endsWith("_at") || col.endsWith("_date")) {
    try {
      return <span style={{ fontSize: 12 }}>{new Date(s).toLocaleDateString()}</span>;
    } catch { return <span>{s}</span>; }
  }
  if (s.length > 40) return <span title={s}>{s.slice(0, 38)}…</span>;
  return <span>{s}</span>;
}

// ─── Add row panel ────────────────────────────────────────────────────────────

function AddRowPanel({
  fields, tableName, insertRow, onDone,
}: {
  fields: Field[];
  tableName: string;
  insertRow: DataClientProps["insertRow"];
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function set(key: string, val: string) {
    setValues((v) => ({ ...v, [key]: val }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const data: Record<string, unknown> = {};
    for (const field of fields) {
      const v = values[field.key];
      if (!v && field.required) {
        setError(`${field.label} is required`);
        setLoading(false);
        return;
      }
      if (v) {
        if (field.type === "number" || field.type === "currency") {
          data[field.key] = Number(v);
        } else {
          data[field.key] = v;
        }
      }
    }

    const { error } = await insertRow(tableName, data);
    if (error) {
      setError(error);
      setLoading(false);
      return;
    }
    setSuccess(true);
    setValues({});
    setTimeout(() => { setSuccess(false); onDone(); }, 800);
    setLoading(false);
  }

  return (
    <div className="card" style={{ padding: 20, marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Add row</div>
        <button className="btn ghost sm" onClick={onDone}><X style={{ width: 12, height: 12 }} /></button>
      </div>
      <form onSubmit={submit}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
          {fields.map((field) => (
            <div key={field.key} className="field" style={{ margin: 0 }}>
              <label style={{ fontSize: 11.5 }}>
                {field.label}{field.required && <span style={{ color: "var(--err)" }}> *</span>}
              </label>
              <FieldInput field={field} value={values[field.key] ?? ""} onChange={(v) => set(field.key, v)} />
            </div>
          ))}
        </div>
        {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--err)" }}>{error}</div>}
        <div className="row" style={{ marginTop: 14, justifyContent: "flex-end", gap: 8 }}>
          {success && <span className="chip ok"><Check style={{ width: 10, height: 10 }} /> Saved</span>}
          <button type="button" className="btn sm" onClick={onDone}>Cancel</button>
          <button type="submit" className="btn accent sm" disabled={loading}>
            {loading ? <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} /> : <Plus style={{ width: 12, height: 12 }} />}
            {loading ? "Saving…" : "Save row"}
          </button>
        </div>
      </form>
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: Field; value: string; onChange: (v: string) => void }) {
  const base = { className: "input", style: { height: 32, fontSize: 13 } as React.CSSProperties };
  if (field.type === "select") {
    return (
      <select {...base} className="sel" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">-</option>
        {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  const inputType = field.type === "currency" || field.type === "number" ? "number"
    : field.type === "date" ? "date"
    : field.type === "email" ? "email"
    : "text";
  return (
    <input
      {...base}
      type={inputType}
      placeholder={field.placeholder ?? field.label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      step={field.type === "currency" ? "0.01" : undefined}
      min={field.type === "currency" || field.type === "number" ? "0" : undefined}
    />
  );
}

// ─── CSV import panel ─────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === "," && !inQ) { result.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  result.push(cur.trim());
  return result;
}

function CsvImportPanel({
  fields, tableName, bulkInsert, onDone,
}: {
  fields: Field[];
  tableName: string;
  bulkInsert: DataClientProps["bulkInsert"];
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<"pick" | "preview" | "importing" | "done">("pick");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({}); // fieldKey → csvHeader
  const [result, setResult] = useState<{ inserted: number; error?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const fieldKeys = fields.map((f) => f.key);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.trim().split(/\r?\n/);
      if (lines.length < 2) return;
      const headers = parseCsvLine(lines[0] ?? "");
      const rows = lines.slice(1, 5001).map((line) => {
        const vals = parseCsvLine(line);
        const row: Record<string, string> = {};
        headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
        return row;
      });
      setCsvHeaders(headers);
      setCsvRows(rows);
      // Auto-map: exact match or fuzzy (strip spaces/underscores)
      const autoMap: Record<string, string> = {};
      for (const fk of fieldKeys) {
        const match = headers.find((h) =>
          h.toLowerCase().replace(/[\s_]/g, "") === fk.toLowerCase().replace(/[\s_]/g, "")
        );
        if (match) autoMap[fk] = match;
      }
      setMapping(autoMap);
      setPhase("preview");
    };
    reader.readAsText(file);
  }

  async function importRows() {
    setPhase("importing");
    // Build rows using mapping
    const rows: Record<string, unknown>[] = csvRows.map((csvRow) => {
      const row: Record<string, unknown> = {};
      for (const field of fields) {
        const header = mapping[field.key];
        if (!header) continue;
        const v = csvRow[header] ?? "";
        if (!v) continue;
        if (field.type === "number" || field.type === "currency") {
          const n = Number(v.replace(/[$,]/g, ""));
          if (!isNaN(n)) row[field.key] = n;
        } else {
          row[field.key] = v;
        }
      }
      return row;
    });

    const res = await bulkInsert(tableName, rows);
    setResult(res);
    setPhase("done");
  }

  return (
    <div className="card" style={{ padding: 20, marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Import CSV</div>
        <button className="btn ghost sm" onClick={onDone}><X style={{ width: 12, height: 12 }} /></button>
      </div>

      {phase === "pick" && (
        <div>
          <p style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 12 }}>
            CSV headers should match field names ({fieldKeys.slice(0, 4).join(", ")}…).
            Column mapping is editable in the next step.
          </p>
          <label className="btn accent sm" style={{ cursor: "pointer", display: "inline-flex", gap: 6 }}>
            <Upload style={{ width: 12, height: 12 }} /> Choose file
            <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleFile} />
          </label>
        </div>
      )}

      {phase === "preview" && (
        <div>
          <div style={{ fontWeight: 500, fontSize: 12.5, marginBottom: 10 }}>
            {csvRows.length.toLocaleString()} rows detected · map columns below
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
            {fields.map((field) => (
              <div key={field.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                <span style={{ minWidth: 120, color: "var(--ink-2)" }}>{field.label}</span>
                <select
                  className="sel"
                  style={{ flex: 1, height: 28, fontSize: 12 }}
                  value={mapping[field.key] ?? ""}
                  onChange={(e) => setMapping((m) => ({ ...m, [field.key]: e.target.value }))}
                >
                  <option value="">(skip)</option>
                  {csvHeaders.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="card" style={{ padding: 10, overflow: "auto", marginBottom: 14, background: "var(--bg-2)" }}>
            <table className="tbl" style={{ fontSize: 11 }}>
              <thead>
                <tr>{csvHeaders.slice(0, 8).map((h) => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {csvRows.slice(0, 3).map((row, i) => (
                  <tr key={i}>
                    {csvHeaders.slice(0, 8).map((h) => <td key={h}>{row[h] ?? ""}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="btn sm" onClick={() => { setPhase("pick"); setCsvRows([]); }}>Back</button>
            <button className="btn accent sm" onClick={importRows}>
              Import {csvRows.length.toLocaleString()} rows
            </button>
          </div>
        </div>
      )}

      {phase === "importing" && (
        <div className="row gap-sm" style={{ color: "var(--ink-2)", fontSize: 13 }}>
          <Loader2 style={{ width: 14, height: 14, animation: "spin 1s linear infinite" }} />
          Importing {csvRows.length.toLocaleString()} rows…
        </div>
      )}

      {phase === "done" && result && (
        <div>
          {result.error ? (
            <div style={{ display: "flex", gap: 8, color: "var(--err)", fontSize: 13 }}>
              <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0, marginTop: 2 }} />
              {result.error}
            </div>
          ) : (
            <div className="row gap-sm" style={{ fontSize: 13 }}>
              <Check style={{ width: 14, height: 14, color: "var(--ok)" }} />
              {result.inserted.toLocaleString()} rows imported successfully.
              <button className="btn ghost sm" onClick={onDone} style={{ marginLeft: "auto" }}>Done</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

