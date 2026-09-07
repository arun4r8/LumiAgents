-- ============================================================================
-- opportunities.sharepoint_folder_id / _url  (#207)
--
-- Each pursued opportunity gets a folder tree on the Lumiture Labs site:
--
--   Shared Documents/General/Opportunity Tracking/{solicitation} - {title}/
--     NOTES/  SOLICITATION/  RESPONSE/
--
-- WHY STORE THE driveItem ID AND NOT JUST THE PATH
--   Path-based lookup breaks silently the first time someone renames a folder in
--   SharePoint, and someone will. A driveItem id survives a rename and a move. The
--   URL is stored alongside it purely so the board card can link out without a
--   Graph round trip on every render.
--
-- Both are nullable and stay null until the opportunity is marked Pursue. A null
-- means "no folder yet", which is the correct state for the great majority of rows.
-- ============================================================================

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS sharepoint_folder_id  text,
  ADD COLUMN IF NOT EXISTS sharepoint_folder_url text;

COMMENT ON COLUMN public.opportunities.sharepoint_folder_id IS
  'driveItem id of the per-project SharePoint folder. An id rather than a path, because a path breaks the first time someone renames the folder.';
COMMENT ON COLUMN public.opportunities.sharepoint_folder_url IS
  'webUrl of that folder, stored so the board card can link out without a Graph call on render.';
