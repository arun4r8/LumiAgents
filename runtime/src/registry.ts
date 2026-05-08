// Central orchestration registry — imported by both worker.ts and workflow.ts.
// Add new orchestrations here; the name key MUST match the `name` field in the definition.

import { z } from "zod";
import type { OrchestrationDefinition } from "./types";

import angieResumeFormatting  from "../../orchestrations/angie/resume-formatting/definition";
import angieResumeScreening   from "../../orchestrations/angie/resume-screening/definition";
import angieCandidateSourcing from "../../orchestrations/angie/candidate-sourcing/definition";
import beadyGovconAssessment  from "../../orchestrations/beady/govcon-assessment/definition";
import beadyOpportunitySearch from "../../orchestrations/beady/opportunity-search/definition";
import moneyDataAnalyst       from "../../orchestrations/money/data-analyst";
import moneyFinancialReport   from "../../orchestrations/money/financial-report/definition";
import patchInboundTriage     from "../../orchestrations/patch/inbound-triage/definition";
import patchTicketOps         from "../../orchestrations/patch/ticket-ops/definition";
import patchStaffRequest      from "../../orchestrations/patch/staff-request/definition";
import * as patchDocumentRag  from "../../orchestrations/patch/document-rag";

type AnyOrch = OrchestrationDefinition<z.ZodTypeAny, z.ZodTypeAny>;

function reg(o: AnyOrch): [string, AnyOrch] {
  return [o.name, o];
}

export const orchestrations = new Map<string, AnyOrch>([
  reg(angieResumeFormatting  as unknown as AnyOrch),
  reg(angieResumeScreening   as unknown as AnyOrch),
  reg(angieCandidateSourcing as unknown as AnyOrch),
  reg(beadyGovconAssessment  as unknown as AnyOrch),
  reg(beadyOpportunitySearch as unknown as AnyOrch),
  reg(moneyDataAnalyst       as unknown as AnyOrch),
  reg(moneyFinancialReport   as unknown as AnyOrch),
  reg(patchInboundTriage     as unknown as AnyOrch),
  reg(patchTicketOps         as unknown as AnyOrch),
  reg(patchStaffRequest      as unknown as AnyOrch),
  reg(patchDocumentRag.documentIngest as unknown as AnyOrch),
  reg(patchDocumentRag.documentQuery  as unknown as AnyOrch),
]);
