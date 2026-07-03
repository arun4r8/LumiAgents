-- Rename the award orchestrations beady/award-* -> cleo/award-* now that they belong
-- to the Cleo (eminence & awards) agent rather than Beady. Renames the live registry
-- rows and their schedules so the meta-cron keeps dispatching them under the new name.
-- (schedules.orchestration_name is plain text — no FK — so a straight UPDATE is safe.)
--
-- Rollback: swap 'cleo/award-' back to 'beady/award-' in the same rows.

UPDATE orchestration.orchestrations SET name = 'cleo/award-sweep'  WHERE name = 'beady/award-sweep';
UPDATE orchestration.orchestrations SET name = 'cleo/award-report' WHERE name = 'beady/award-report';
UPDATE orchestration.schedules SET orchestration_name = 'cleo/award-sweep'  WHERE orchestration_name = 'beady/award-sweep';
UPDATE orchestration.schedules SET orchestration_name = 'cleo/award-report' WHERE orchestration_name = 'beady/award-report';
