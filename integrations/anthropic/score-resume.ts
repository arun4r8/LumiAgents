import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Env } from "../../runtime/src/types";

const DEFAULT_MODEL = "claude-haiku-4-5";

// Scoring rubric — ported verbatim from the n8n "HR Expert LLM" system message so
// scores stay comparable with historical results.
const RUBRIC_SYSTEM = `You are a strict professional resume evaluator used by enterprise hiring systems and senior recruiters for the specified role above.
If the specified role is Lumiture, refer to the Lumiture job description to assess applicant.
If no discernible role is specified, refer to the Lumiture job description to assess applicant.
Your task is to critically assess the resume below.
Only score what is explicitly present.

Evaluation Philosophy (CRITICAL):
	- Assume 500+ applicants for this role - only exceptional candidates deserve high scores
	- A 10/10 is nearly impossible - reserved for exceptional demonstrated achievement
	- 7-8/10 means clearly hire-worthy with strong evidence
	- 5-6/10 means acceptable but not competitive
	- Below 5/10 means not qualified or too weak to consider
	- EVIDENCE MATTERS: Claims without metrics, outcomes, or specifics = ZERO credit
	- Buzzword lists without context = ZERO credit
	- "Familiar with" or "exposure to" = weak, scores poorly
	- Demonstrated impact with numbers = strong, scores well

CRITICAL SCORING RULES:
        - If Technical Skills + Work Experience both score below 5, Overall CANNOT exceed 4
        - If no quantifiable achievements exist anywhere, no category can score above 6
        - If GPA is below 3.0 AND no strong work experience, overall CANNOT exceed 5
        - Default assumption is 4-5/10 unless STRONG evidence pushes it higher

Instructions:
- Return Profile Info:
  1) Full Name
  2) Email
  3) Mobile Number
  4) Location
  5) School
  6) Major/Degree
  7) GPA
  8) Grad Year
- Return specified role
- Rigorously score the candidate 1–10 in each category:
  1) Technical Skills Relevance: Alignment of technical skills (Python, JS/TS, React, databases, cloud, ML/AI frameworks) with job requirements
  2) Work Experience Quality:  Depth, relevance, and impact of prior work experience (measurable achievements)
  3) Education & Academic Achievement: Quality of institution, GPA, relevant coursework, academic honors
  4) Projects & Research: Quality, scope, and technical complexity of personal/academic projects or research
  5) Leadership & Initiative: Evidence of leadership roles, entrepreneurship, or self-driven initiatives
  6) Overall: Assessment of growth trajectory and likelihood of success in role
- Prepare a 2–3 sentence rationale supporting scoring

Output:
-Return ONLY valid JSON (no extra text) with exactly these keys:
  1) name
  2) email
  3) number
  4) location
  5) school
  6) major
  7) gpa
  8) gradyr
  9) role
  10) technical_skills_score
  11) work_experience_score
  12) academic_achievement_score
  13) projects_research_score
  14) leadership_initiative_score
  15) overall_score
  16) rationale`;

// Lumiture job description — ported verbatim from the n8n flow. Used only when the
// specified role is "Lumiture" (or when no role is given), matching the original.
const LUMITURE_JD = `About us-
At Lumiture, we’re building next-generation solutions that fuse AI, data, and modern engineering to power intelligent experiences across industries. We’re not just coding apps — we’re shaping how technology helps businesses think, learn, and evolve.
If you love solving big problems, experimenting with cutting-edge tools, and making an impact from day one, you’ll feel right at home here.

The Role-
a unique opportunity to grow alongside a rapidly evolving team.
We’re looking for someone passionate about building, learning, and innovating across disciplines - whether it’s full-stack web development, data pipelines, or AI model integration.
You’ll collaborate with experienced engineers, designers, and data scientists to turn ideas into real-world products. Every day will look a little different - and that’s the point!
What You'll Have Opportunities to Do:
* Design, build, and deploy scalable applications or data systems using modern tech stacks.
* Experiment with AI models, APIs, and automation tools to create intelligent workflows.
* Work across frontend, backend, and cloud infrastructure - depending on your interests and project needs.
* Partner with cross-functional teams to define, prototype, and iterate on new features.
* Learn continuously - and share what you learn. We believe great engineers grow through curiosity and creativity.
What We're Looking For:
* BS or MS in Computer Science, Data Science, Engineering, Business IT/ MIS or a related field.
* Knowledge and/or hands-on experience (internships, projects, or coursework) with one or more of:
1. Python, JavaScript/TypeScript, React, or Node.js
2. SQL / NoSQL databases
3. Cloud platforms (AWS, GCP, Azure)
4. Machine Learning or AI frameworks (OpenAI API, TensorFlow, PyTorch, LangChain, etc.)
* A builder’s mindset — you love figuring things out, trying new tools, and taking ideas from zero to one.
* Excellent communication and teamwork skills.
Why Join Lumiture
* Be part of a growing startup where your code has an immediate impact.
* Work directly with a team that values creativity, innovation, and exploration.
* Access mentorship from experienced engineers and data scientists.
* Enjoy flexibility, growth opportunities, and a culture built around learning fast and thinking bold.`;

// Output contract — same 16 keys the n8n HR scorer returned.
export const scoredResumeSchema = z.object({
  name: z.string(),
  email: z.string(),
  number: z.string(),
  location: z.string(),
  school: z.string(),
  major: z.string(),
  gpa: z.string(),
  gradyr: z.string(),
  role: z.string(),
  technical_skills_score: z.number(),
  work_experience_score: z.number(),
  academic_achievement_score: z.number(),
  projects_research_score: z.number(),
  leadership_initiative_score: z.number(),
  overall_score: z.number(),
  rationale: z.string(),
});
export type ScoredResume = z.infer<typeof scoredResumeSchema>;

const STR = { type: "string" } as const;
const SCORE = { type: "integer", minimum: 1, maximum: 10 } as const;
const EVAL_TOOL_SCHEMA = {
  type: "object",
  properties: {
    name: STR, email: STR, number: STR, location: STR, school: STR, major: STR,
    gpa: STR, gradyr: STR, role: STR,
    technical_skills_score: SCORE,
    work_experience_score: SCORE,
    academic_achievement_score: SCORE,
    projects_research_score: SCORE,
    leadership_initiative_score: SCORE,
    overall_score: SCORE,
    rationale: STR,
  },
  required: [
    "name", "email", "number", "location", "school", "major", "gpa", "gradyr", "role",
    "technical_skills_score", "work_experience_score", "academic_achievement_score",
    "projects_research_score", "leadership_initiative_score", "overall_score", "rationale",
  ],
};

export interface ScoreResumeInput {
  rolekey: string;
  pdfBase64: string;
  model?: string;
}

// Single Claude call: reads the résumé PDF directly, extracts the profile fields, and
// scores against the rubric. Replaces the n8n two-extractor + HR-scorer chain with one
// structured-output call (forced tool use), so there is no fence-stripping or
// decimal-coercion hack and tokens are attributable to the run.
export async function scoreResume(env: Env, input: ScoreResumeInput): Promise<ScoredResume> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const userText =
    `Role Specified: ${input.rolekey}\n\n` +
    `Lumiture Job Description (ONLY use if the role specified is Lumiture):\n\n${LUMITURE_JD}\n\n` +
    `The candidate's résumé is attached as a PDF. Extract the profile fields directly from it, then score per the rubric and submit via the submit_evaluation tool.`;

  const response = await client.messages.create({
    model: input.model ?? DEFAULT_MODEL,
    max_tokens: 1024,
    system: RUBRIC_SYSTEM,
    tools: [
      {
        name: "submit_evaluation",
        description: "Submit the candidate's extracted profile fields and rubric scores.",
        input_schema: EVAL_TOOL_SCHEMA as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "submit_evaluation" },
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.pdfBase64 } },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Resume scorer: model did not return an evaluation");
  }
  return scoredResumeSchema.parse(toolUse.input);
}
