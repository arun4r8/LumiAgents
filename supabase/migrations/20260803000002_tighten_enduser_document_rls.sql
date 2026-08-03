-- Tighten enduser read access to the knowledge base.
--
-- With endusers now enabled, the existing enduser_read policies on orch_documents
-- and document_chunks were `USING (public.is_enduser())` — i.e. an enduser could
-- SELECT EVERY document and chunk directly via the DB, including `restricted`
-- (financials / client-confidential / security) content. That bypasses the
-- runtime's role-scoped retrieval (which already fences endusers to shared+enduser
-- and excludes restricted). Align the DB with the runtime: endusers may read only
-- non-restricted documents in the `shared` or `enduser` corpora.
--
-- corpus/sensitivity live on orch_documents only; document_chunks gate via their
-- parent document.
--
-- Rollback: restore `USING (public.is_enduser())` on both policies.

ALTER POLICY "enduser_read" ON orchestration.orch_documents
  USING (
    public.is_enduser()
    AND sensitivity <> 'restricted'
    AND corpus IN ('shared', 'enduser')
  );

ALTER POLICY "enduser_read" ON orchestration.document_chunks
  USING (
    public.is_enduser()
    AND EXISTS (
      SELECT 1 FROM orchestration.orch_documents d
      WHERE d.id = document_chunks.document_id
        AND d.sensitivity <> 'restricted'
        AND d.corpus IN ('shared', 'enduser')
    )
  );
