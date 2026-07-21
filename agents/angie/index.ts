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
  ],
  toolMap: {
    score_resumes:     { orchestration: "angie/resume-scoring" },
    source_candidates: { orchestration: "angie/candidate-sourcing" },
    format_resume:     { orchestration: "angie/resume-formatting" },
  },
};
