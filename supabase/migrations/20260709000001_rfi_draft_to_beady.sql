-- Move the RFI-drafting orchestration from Cleo to Beady. An RFI / Sources Sought
-- response operates on an opportunity (Beady's table), fetches the SAM attachment
-- (Beady's SAM integration), and is the natural next step after a go/no-go — so it
-- belongs to the opportunity lifecycle Beady owns, not Cleo's eminence/awards lane.
--
-- Rollback:
--   UPDATE orchestration.orchestrations SET name='cleo/rfi-draft' WHERE name='beady/rfi-draft';

UPDATE orchestration.orchestrations
SET name = 'beady/rfi-draft'
WHERE name = 'cleo/rfi-draft';
