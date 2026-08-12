import type { AgentDefinition } from "../types";

export const angie: AgentDefinition = {
  slug: "angie",
  displayName: "Angie",
  systemPrompt: `You are Angie, Lumiture's AI recruiting and HR assistant. You help with:
- Sourcing candidates from Apollo based on role requirements
- Answering questions about hiring pipelines and candidate status
- Advising on job descriptions and interview criteria
- Reformatting employee resumes for consulting client proposals

Be concise and professional. When you trigger an orchestration, tell the user what you started and link them to the run.
Do not use em dashes.`,
  tools: [
    {
      name: "score_resumes",
      examples: [
        "Screen these resumes for a cleared IT PM role",
      ],
      description: "Score and rank candidate résumés against a job description using the AI pipeline. Attach the PDF résumés to this message (multiple allowed; batch processing is supported). Non-PDF files are converted automatically.",
      inputSchema: {
        type: "object",
        properties: {
          jobDescription: { type: "string", description: "Role title and key requirements to score against" },
          jobId: { type: "string", description: "Optional existing resume_jobs row ID to append results to" },
        },
        required: ["jobDescription"],
      },
    },
    {
      name: "source_candidates",
      examples: [
        "Find 5 senior Java developers in DC",
      ],
      description: "Search Apollo for candidates matching a role. Runs a sourcing workflow that scores and filters results.",
      inputSchema: {
        type: "object",
        properties: {
          jobTitle: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
          location: { type: "string" },
          clearanceRequired: { type: "boolean" },
        },
        required: ["jobTitle"],
      },
    },
    {
      name: "format_resume",
      examples: [
        "Reformat this resume for a data scientist proposal",
      ],
      description: "Reformat an employee's resume for a consulting client proposal. Tailors content to a target role, removes weak language, quantifies impact, and trims to 3 pages.",
      inputSchema: {
        type: "object",
        properties: {
          resume_text: { type: "string", description: "Raw resume text to reformat" },
          target_role: {
            type: "string",
            enum: ["data-scientist", "analytics-practitioner", "data-engineer"],
            description: "Target role for tailored formatting",
          },
          employee_name: { type: "string", description: "Employee name for personalised header (optional)" },
        },
        required: ["resume_text", "target_role"],
      },
    },
    {
      name: "redact_resume",
      examples: [
        "Make a blind copy of this resume for the client",
        "Strip the name and contact details off this resume",
      ],
      description:
        "Produce a blind (client-submission) copy of a resume: strips the candidate's name, contact details, personal links and referees so a client evaluates the experience before the person. Returns redaction-verified text ready to render on Lumiture letterhead. Use this when asked for a blind, anonymised or client-ready resume. This does NOT redact employer names.",
      inputSchema: {
        type: "object",
        properties: {
          resume_text: { type: "string", description: "Raw resume text to redact" },
          candidate_code: {
            type: "string",
            description:
              "Optional non-identifying label printed where the name was, e.g. 'LUM-0042', so a submission can be traced back internally. Omit for a fully anonymous document.",
          },
        },
        required: ["resume_text"],
      },
    },
    {
      name: "get_recent_candidates",
      examples: [
        "Who scored well in the last batch?",
      ],
      description:
        "Get top-scored candidates from résumé scoring jobs run recently (e.g. 'who scored well from today's batch'). Reads existing results; does not score anything new.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max candidates to return (default 10, max 50)" },
          sinceHours: { type: "number", description: "How far back to look, in hours (default 24)" },
        },
      },
    },
  ],
  toolMap: {
    score_resumes:     { orchestration: "angie/resume-scoring" },
    source_candidates: { orchestration: "angie/candidate-sourcing" },
    format_resume:     { orchestration: "angie/resume-formatting" },
    redact_resume:     { orchestration: "angie/resume-redact", mode: "sync" },
    get_recent_candidates: { orchestration: "angie/recent-resume-jobs", mode: "sync" },
  },
};
