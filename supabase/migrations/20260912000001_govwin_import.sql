-- ============================================================================
-- GovWin IQ import: the forecast half of the BD pipeline  (#198)
--
-- The SAM.gov sweep can only see what is posted to SAM.gov. The pursuit BD is
-- running right now -- Advana / Army Vantage -- is GSA eBuy RFQ1835138, visible
-- only to schedule holders on the eBuy portal and never posted to SAM at all. It
-- was invisible to this system while being the single most important thing in it.
--
-- BD already maintains a GovWin IQ export by hand in SharePoint and works from it
-- directly. 83% of that export matches the five NAICS codes the sweep searches, so
-- it is the same pipeline seen earlier: forecasts, pre-solicitation, and the
-- portals SAM does not cover.
--
-- Three columns of it have no SAM.gov equivalent, which is why this needs schema
-- rather than just a mapper:
--
--   estimated_value_usd  GovWin publishes a contract value. SAM does not, so
--                        nothing in the pipeline has ever known what a pursuit is
--                        worth. Stored in DOLLARS -- the export is in thousands
--                        and integrations/govwin/import.ts does that conversion.
--   incumbent            Who holds it now. The first question asked about any
--                        pursuit, and previously answerable only by hand.
--   vehicle              Already exists on the table (legacy, never populated).
--                        This finally gives it a writer.
--
-- source='govwin' joins the existing CHECK. The dedup key stays
-- opportunities.sam_notice_id, which despite its name is the generic external id
-- -- SBIR already stores `sbir_<topic>` there; GovWin stores `govwin_<Opp ID>`.
--
-- Rollback:
--   ALTER TABLE public.opportunities DROP COLUMN estimated_value_usd, DROP COLUMN incumbent;
--   ALTER TABLE public.opportunities DROP CONSTRAINT opportunities_source_check;
--   ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_source_check
--     CHECK (source = ANY (ARRAY['manual','sam_gov','sbir','govcon_api']));
--   DELETE FROM orchestration.schedules WHERE orchestration_name='beady/govwin-import';
--   DELETE FROM orchestration.orchestrations WHERE name='beady/govwin-import';
-- ============================================================================

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS estimated_value_usd bigint,
  ADD COLUMN IF NOT EXISTS incumbent           text;

COMMENT ON COLUMN public.opportunities.estimated_value_usd IS
  'Estimated contract value in DOLLARS. GovWin exports thousands; the importer multiplies. Null for SAM.gov rows, which carry no value.';
COMMENT ON COLUMN public.opportunities.incumbent IS
  'Current contract holder, where the source names one. GovWin only.';

ALTER TABLE public.opportunities DROP CONSTRAINT opportunities_source_check;
ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_source_check
  CHECK (source = ANY (ARRAY['manual', 'sam_gov', 'sbir', 'govcon_api', 'govwin']));

INSERT INTO orchestration.orchestrations (name, version, description, input_schema, output_schema, is_active, trigger_mode)
VALUES ('beady/govwin-import', 1,
  'Read BD''s GovWin IQ export from SharePoint, score the near-term rows, and upsert the shortlist into opportunities alongside the SAM.gov sweep.',
  '{}', '{}', true, 'cron')
ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description, is_active = EXCLUDED.is_active;

-- Weekly, not daily. The export is refreshed by hand, so a daily run would spend
-- the LLM budget re-reading an unchanged file; the content-hash ledger would catch
-- it, but not before the read. Monday 07:40 puts it in front of the sweep's 08:00,
-- so a Monday morning board is complete rather than half-populated.
INSERT INTO orchestration.schedules (orchestration_name, cron_expression, label, default_input, is_active)
SELECT 'beady/govwin-import', '40 7 * * 1', 'Weekly GovWin export import', '{}'::jsonb, true
WHERE NOT EXISTS (SELECT 1 FROM orchestration.schedules WHERE orchestration_name = 'beady/govwin-import');
