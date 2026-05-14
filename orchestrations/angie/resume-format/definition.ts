import { defineOrchestration, llm_extract } from "@/runtime";
import { z } from "zod";

const inputSchema = z.object({
  resume_text: z.string().describe("Raw resume text to reformat"),
  target_role: z
    .enum(["data-scientist", "analytics-practitioner", "data-engineer"])
    .describe("Target role for tailored formatting"),
  employee_name: z.string().optional().describe("Employee name for personalised header"),
});

const parsedResumeSchema = z.object({
  name: z.string(),
  summary: z.string().optional(),
  positions: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      start_date: z.string(),
      end_date: z.string(),
      bullets: z.array(z.string()),
      industry: z.string().optional(),
    })
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      year: z.string().optional(),
    })
  ),
  skills: z.array(z.string()),
  certifications: z.array(z.string()).optional(),
});

const outputSchema = z.object({
  formatted_resume: z
    .string()
    .describe("The fully reformatted resume in plain text, ready to share with clients"),
  changes_summary: z
    .string()
    .describe("Bullet-point summary of major changes made during reformatting"),
});

const ROLE_GUIDANCE: Record<string, string> = {
  "data-scientist": `
TARGET ROLE: Consumer Product Data Scientist
- Emphasise ML modelling, experimentation (A/B tests, causal inference), and product metric work
- Highlight Python, SQL, and any stats/modelling libraries (scikit-learn, statsmodels, XGBoost, etc.)
- Lead bullets with business outcomes (revenue impact, retention lift, forecast accuracy) not just methodology
- If the candidate has private-sector consumer-product or e-commerce experience, surface it prominently
- Cut academic / government project language; reframe in product impact terms
`,
  "analytics-practitioner": `
TARGET ROLE: Sr. Data Analytics Practitioner
- Emphasise cross-functional stakeholder influence, self-service analytics, and insight-to-decision loops
- Highlight BI tools (Tableau, Looker, Power BI), SQL, and any data modelling / dbt work
- Add a PM-clarity pass: each bullet should name the business question answered, not just the technical artifact built
- If the candidate drove adoption of a dashboard or analytics capability across teams, surface that explicitly
- Reframe "built report for X" as "enabled X team to answer Y, reducing decision latency by Z"
`,
  "data-engineer": `
TARGET ROLE: Sr. Data Engineer
- Emphasise pipeline reliability, data quality, scale (rows/day, tables, SLA), and system ownership
- Highlight cloud platforms (AWS, GCP, Azure), orchestration (Airflow, Prefect, dbt), and storage (Redshift, BigQuery, Snowflake)
- Lead bullets with operational outcomes: reduced pipeline failures, cut processing time, enabled new data product
- If the candidate has experience serving ML/analytics consumers from a data platform, call that out specifically
- Private sector data engineering experience (fintech, retail, healthtech) is a differentiator — surface it first
`,
};

const FORMATTING_RULES = `
UNIVERSAL FORMATTING CONSTRAINTS
1. Maximum 3 pages when printed. Prune aggressively if needed.
2. Each position gets 2–3 high-impact bullets only. Remove filler bullets entirely.
3. Replace weak verbs with strong action verbs:
   - "supported" → led, built, drove, owned, delivered
   - "helped with" → contributed to (only if the contribution was significant; otherwise cut)
   - "guided" → directed, mentored, shaped
   - "advised" → recommended, influenced, defined
   - "participated in" → led, ran, executed (or cut if passive)
4. Quantify every metric that can be quantified. If a number isn't in the original, use ranges or omit the claim.
5. Private industry experience should appear before government/public sector experience in bullets, even within the same role.
6. Skills section: list only technologies actually mentioned in the resume body. Remove aspirational or unverified skills.
7. Professional Summary: 3 sentences max. Open with a strong claim about the candidate's primary value. End with the type of engagement they excel at.
8. Do NOT invent accomplishments. If you reword something, preserve factual accuracy.
9. Output the resume in clean plain text. Use consistent section headers: PROFESSIONAL SUMMARY, EXPERIENCE, EDUCATION, SKILLS, CERTIFICATIONS.
`;

export default defineOrchestration({
  name: "angie/resume-formatting",
  version: 1,
  description:
    "Reformat an employee's existing resume for consulting client proposals. Tailors content to one of three target roles, removes weak language, quantifies impact, and trims to 3 pages.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops", "role:hr"],
    visibleTo: ["role:ops", "role:hr"],
  },

  async run(ctx, input) {
    const parsed = await llm_extract(ctx, {
      name: "parse-resume",
      prompt: `Parse the resume into structured JSON. Extract every position, all bullet points verbatim, education, and skills exactly as written. Do not rephrase or improve anything at this stage — faithful extraction only.`,
      input: { resume_text: input.resume_text },
      schema: parsedResumeSchema,
    });

    const roleGuidance = ROLE_GUIDANCE[input.target_role];

    const formatted = await llm_extract(ctx, {
      name: "format-resume",
      prompt: `You are an expert resume writer preparing consulting-company employee profiles for client proposals. Reformat the parsed resume according to the role-specific guidance and universal formatting rules provided in the context.

Return:
1. formatted_resume: the complete reformatted resume as plain text, ready to copy-paste
2. changes_summary: a concise bullet list of every substantive change made (removed bullets, reworded claims, reordered sections, quantified metrics, etc.)`,
      input: {
        formatting_rules: FORMATTING_RULES,
        role_guidance: roleGuidance,
        parsed_resume: parsed,
        employee_name: input.employee_name ?? null,
      },
      schema: outputSchema,
    });

    return formatted;
  },
});
