import type { RunContext } from "../../runtime/src/types";

const BUCKET = "resumes";

async function supabaseInsert(
  ctx: RunContext,
  table: string,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(`${ctx.env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert ${table} → ${res.status}: ${text}`);
  }
  const rows = (await res.json()) as Record<string, unknown>[];
  const inserted = rows[0];
  if (!inserted) throw new Error(`${table} insert returned no row`);
  return inserted;
}

async function uploadPdf(
  ctx: RunContext,
  jobId: string,
  filename: string,
  base64: string,
): Promise<string> {
  const storagePath = `${BUCKET}/${jobId}/${filename}`;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const res = await ctx.fetch(
    `${ctx.env.SUPABASE_URL}/storage/v1/object/${storagePath}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        apikey: ctx.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: bytes,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Storage upload ${storagePath} → ${res.status}: ${text}`);
  }
  return storagePath;
}

export interface DirectResumeIntakeInput {
  jobId: string;
  jobDescription: string;
  pdfBase64s: string[];
}

// Upload PDFs directly to Supabase Storage and insert resume_jobs / agent_tasks /
// resume_queue rows — no n8n intake webhook needed, so concurrent runs from
// multiple orchestrations never hit n8n's concurrency cap during intake.
export async function directResumeIntake(
  ctx: RunContext,
  input: DirectResumeIntakeInput,
): Promise<{ jobId: string; submitted: number }> {
  const { jobId, jobDescription, pdfBase64s } = input;

  await supabaseInsert(ctx, "resume_jobs", {
    id: jobId,
    status: "processing",
    total: pdfBase64s.length,
    processed: 0,
    job: jobDescription,
  });

  await supabaseInsert(ctx, "agent_tasks", {
    id: jobId,
    source: "orchestration",
    task_type: "Resume Scoring",
    input_json: JSON.stringify({ roleKey: jobDescription, fileCount: pdfBase64s.length }),
    agent: "Angie",
    status: "pending",
  });

  for (let i = 0; i < pdfBase64s.length; i++) {
    const storagePath = await uploadPdf(ctx, jobId, `resume_${i}.pdf`, pdfBase64s[i]!);
    await supabaseInsert(ctx, "resume_queue", {
      job_id: jobId,
      payload: { rolekey: jobDescription, path: storagePath },
      status: "queued",
    });
  }

  return { jobId, submitted: pdfBase64s.length };
}
