// Central orchestration registry, imported by both worker.ts and workflow.ts.
// Add new orchestrations here; the name key MUST match the `name` field in the definition.

import { z } from "zod";
import type { OrchestrationDefinition } from "./types";

import angieCandidateSourcing    from "../../orchestrations/angie/candidate-sourcing/definition";
import angieResumeFormat         from "../../orchestrations/angie/resume-format/definition";
import angieResumeRedact         from "../../orchestrations/angie/resume-redact/definition";
import angieResumeScoring        from "../../orchestrations/angie/resume-scoring/definition";
import angieRecentResumeJobs     from "../../orchestrations/angie/recent-resume-jobs/definition";
import beadyGovconAssessment     from "../../orchestrations/beady/govcon-assessment/definition";
import beadyPastPerformanceSeed  from "../../orchestrations/beady/past-performance-seed/definition";
import beadyOpportunitySweep    from "../../orchestrations/beady/opportunity-sweep/definition";
import beadyOpportunityReport   from "../../orchestrations/beady/opportunity-report/definition";
import beadyRfiDraft           from "../../orchestrations/beady/rfi-draft/definition";
import beadyIndustryDaySweep   from "../../orchestrations/beady/industry-day-sweep/definition";
import beadyRecentOpportunities from "../../orchestrations/beady/recent-opportunities/definition";
import cleoAwardSweep          from "../../orchestrations/cleo/award-sweep/definition";
import cleoAwardReport         from "../../orchestrations/cleo/award-report/definition";
import cleoContentDraft        from "../../orchestrations/cleo/content-draft/definition";
import cleoContentPlan         from "../../orchestrations/cleo/content-plan/definition";
import cleoContentNudge        from "../../orchestrations/cleo/content-nudge/definition";
import cleoContentSync         from "../../orchestrations/cleo/content-sync/definition";
import cleoRecentAwards        from "../../orchestrations/cleo/recent-awards/definition";
import cleoRecentContent       from "../../orchestrations/cleo/recent-content/definition";
import deweyKnowledgeSearch    from "../../orchestrations/dewey/knowledge-search/definition";
import deweyRetagDocument      from "../../orchestrations/dewey/retag-document/definition";
import deweyKnowledgeInventory from "../../orchestrations/dewey/knowledge-inventory/definition";
import moneyDataAnalyst       from "../../orchestrations/money/data-analyst/definition";
import moneyFinancialReport   from "../../orchestrations/money/financial-report/definition";
import patchInboundTriage     from "../../orchestrations/patch/inbound-triage/definition";
import patchTicketOps         from "../../orchestrations/patch/ticket-ops/definition";
import patchTicketSearch      from "../../orchestrations/patch/ticket-search/definition";
import patchStaffRequest      from "../../orchestrations/patch/staff-request/definition";
import * as patchDocumentRag  from "../../orchestrations/patch/document-rag/definition";
import systemMemoryMaintenance from "../../orchestrations/system/memory-maintenance/definition";
import systemRunWatchdog from "../../orchestrations/system/run-watchdog/definition";
import beadyOpportunityHydrate from "../../orchestrations/beady/opportunity-hydrate/definition";
import beadyProjectFolder from "../../orchestrations/beady/project-folder/definition";

type AnyOrch = OrchestrationDefinition<z.ZodTypeAny, z.ZodTypeAny>;

function reg(o: AnyOrch): [string, AnyOrch] {
  return [o.name, o];
}

export const orchestrations = new Map<string, AnyOrch>([
  reg(angieCandidateSourcing   as unknown as AnyOrch),
  reg(angieResumeFormat        as unknown as AnyOrch),
  reg(angieResumeRedact        as unknown as AnyOrch),
  reg(angieResumeScoring       as unknown as AnyOrch),
  reg(angieRecentResumeJobs    as unknown as AnyOrch),
  reg(beadyGovconAssessment    as unknown as AnyOrch),
  reg(beadyPastPerformanceSeed as unknown as AnyOrch),
  reg(beadyOpportunitySweep   as unknown as AnyOrch),
  reg(beadyOpportunityReport  as unknown as AnyOrch),
  reg(beadyRfiDraft          as unknown as AnyOrch),
  reg(beadyIndustryDaySweep  as unknown as AnyOrch),
  reg(beadyRecentOpportunities as unknown as AnyOrch),
  reg(cleoAwardSweep         as unknown as AnyOrch),
  reg(cleoAwardReport        as unknown as AnyOrch),
  reg(cleoContentDraft       as unknown as AnyOrch),
  reg(cleoContentPlan        as unknown as AnyOrch),
  reg(cleoContentNudge       as unknown as AnyOrch),
  reg(cleoContentSync        as unknown as AnyOrch),
  reg(cleoRecentAwards       as unknown as AnyOrch),
  reg(cleoRecentContent      as unknown as AnyOrch),
  reg(deweyKnowledgeSearch   as unknown as AnyOrch),
  reg(deweyRetagDocument     as unknown as AnyOrch),
  reg(deweyKnowledgeInventory as unknown as AnyOrch),
  reg(moneyDataAnalyst         as unknown as AnyOrch),
  reg(moneyFinancialReport   as unknown as AnyOrch),
  reg(patchInboundTriage     as unknown as AnyOrch),
  reg(patchTicketOps         as unknown as AnyOrch),
  reg(patchTicketSearch      as unknown as AnyOrch),
  reg(patchStaffRequest      as unknown as AnyOrch),
  reg(patchDocumentRag.documentIngest as unknown as AnyOrch),
  reg(patchDocumentRag.documentQuery  as unknown as AnyOrch),
  reg(systemMemoryMaintenance as unknown as AnyOrch),
  reg(systemRunWatchdog as unknown as AnyOrch),
  reg(beadyOpportunityHydrate as unknown as AnyOrch),
  reg(beadyProjectFolder as unknown as AnyOrch),
]);
