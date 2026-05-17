-- Insert angie/resume-scoring orchestration and update beady/govcon-assessment
-- input_schema so the dashboard trigger forms render PDF upload inputs.
-- The "format" property is a UI hint: "pdf-file" = single upload, "pdf-files" = multi.

INSERT INTO orchestration.orchestrations
  (name, version, description, input_schema, output_schema, is_active)
VALUES (
  'angie/resume-scoring', 1,
  'Batch-score candidate résumés (PDF) against a job description. Supports multiple résumés per run.',
  '{
    "type": "object",
    "properties": {
      "jobDescription": {
        "type": "string",
        "description": "Role title and key requirements to score against"
      },
      "pdfBase64s": {
        "type": "array",
        "format": "pdf-files",
        "description": "PDF résumés to score — attach in chat or upload here (batch supported)"
      },
      "jobId": {
        "type": "string",
        "description": "Existing resume_jobs row ID to append results to (optional)"
      }
    },
    "required": ["jobDescription", "pdfBase64s"]
  }',
  '{"type":"object","properties":{"jobId":{"type":"string"},"submitted":{"type":"number"}}}',
  true
)
ON CONFLICT (name, version) DO UPDATE SET
  description  = EXCLUDED.description,
  input_schema = EXCLUDED.input_schema,
  is_active    = EXCLUDED.is_active,
  updated_at   = now();

-- Update govcon-assessment to surface the optional PDF upload field.
UPDATE orchestration.orchestrations
SET
  input_schema = '{
    "type": "object",
    "properties": {
      "opportunityId": {
        "type": "string",
        "description": "Supabase opportunity row ID (UUID)"
      },
      "sourceUrl": {
        "type": "string",
        "description": "SAM.gov or solicitation URL (optional)"
      },
      "notes": {
        "type": "string",
        "description": "Analyst context or notes"
      },
      "solicitationPdfBase64": {
        "type": "string",
        "format": "pdf-file",
        "description": "Solicitation document PDF — single file only (optional)"
      }
    },
    "required": ["opportunityId"]
  }',
  updated_at = now()
WHERE name = 'beady/govcon-assessment' AND version = 1;
