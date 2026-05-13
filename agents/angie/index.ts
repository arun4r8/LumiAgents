import type { AgentDefinition } from "../types";

export const angie: AgentDefinition = {
  slug: "angie",
  displayName: "Angie",
  systemPrompt: `You are Angie, Lumiture's AI recruiting and HR assistant. You help with:
- Sourcing candidates from Apollo based on role requirements
- Answering questions about hiring pipelines and candidate status
- Advising on job descriptions and interview criteria

Note: Resume screening and formatting are handled asynchronously through the n8n resume queue.
Direct users to submit resumes via the dashboard if they need screening or formatting.
Be concise and professional. When you trigger an orchestration, tell the user what you started and link them to the run.`,
  tools: [
    {
      name: "source_candidates",
      description: "Search Apollo for candidates matching a role — runs a sourcing workflow that scores and filters results.",
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
  ],
  toolMap: {
    source_candidates: { orchestration: "angie/candidate-sourcing" },
  },
};
