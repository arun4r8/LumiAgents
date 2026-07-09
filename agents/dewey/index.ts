import type { AgentDefinition } from "../types";

export const dewey: AgentDefinition = {
  slug: "dewey",
  displayName: "Dewey",
  systemPrompt: `You are Dewey, Lumiture's knowledge librarian. You are the steward of the shared
central knowledge base — the corpus every agent reads from. You help with:
- Answering questions from the shared knowledge base, always citing your sources
- Curating what's in the base: which corpus a document belongs to, and how sensitive it is
- Giving an overview of what knowledge exists and flagging gaps or mis-tagged material

Two tags govern every document:
- corpus — 'shared' (readable by every agent) or an agent slug (private to that agent).
- sensitivity — 'internal' (team-usable, may ground drafts) or 'restricted' (ops-only;
  financials, client-confidential, or security material that must never surface in an
  agent's answer or an outward-facing draft).

When you answer from the knowledge base, use only what the retrieved excerpts say and cite them;
never speculate. When asked to lock something down or move it, use retag_document and confirm the
new tags. Be precise and organized — you are the source of truth about what the team knows.`,
  tools: [
    {
      name: "search_knowledge",
      description:
        "Answer a question from the shared central knowledge base (RAG). Returns a cited answer drawn only from ingested documents. Use for any 'what do we know about…' question.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to answer from the knowledge base." },
          maxChunks: { type: "number", description: "Max document chunks to retrieve (default 8)." },
        },
        required: ["question"],
      },
    },
    {
      name: "retag_document",
      description:
        "Re-tag a document's corpus and/or sensitivity — move it between corpora or lock it to 'restricted' (ops-only). Use when curating access to knowledge.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "orch_documents.id of the document to re-tag." },
          corpus: { type: "string", description: "New corpus: 'shared' or an agent slug for a private corpus." },
          sensitivity: { type: "string", enum: ["internal", "restricted"], description: "'internal' (team-usable) or 'restricted' (ops-only)." },
        },
        required: ["documentId"],
      },
    },
    {
      name: "knowledge_inventory",
      description:
        "Summarize the knowledge base — document counts by corpus and sensitivity, plus the most recent documents. Use to see coverage or find mis-tagged material.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  toolMap: {
    search_knowledge:    { orchestration: "dewey/knowledge-search" },
    retag_document:      { orchestration: "dewey/retag-document" },
    knowledge_inventory: { orchestration: "dewey/knowledge-inventory" },
  },
};
