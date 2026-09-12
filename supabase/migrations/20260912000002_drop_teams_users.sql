-- ============================================================================
-- Drop orchestration.teams_users, and retire the Teams wording it came with
--
-- WHAT IT WAS FOR
--   20260624000001 (agent memory, Phase 1) added it to map a Teams AAD user id
--   to a Lumiture auth.users id, so a chat with an agent in Microsoft Teams would
--   attach to the same per-(user, agent) memory as the same person's chat in the
--   dashboard. The runtime wrote a row on every Teams turn, whether or not the
--   user could be mapped, precisely so an admin could link them later.
--
-- WHY IT GOES
--   The Teams bot never worked, so the table never took a row. Production has
--   0 rows in orchestration.teams_users. The corroborating number is next door:
--   orchestration.conversations has 881 rows and external_id -- written on every
--   successful Teams turn and on nothing else -- is null on all 881 of them.
--
--   The cause was never auth. A deep link to the bot answers "You do not have
--   permission to use this app here": the app was never installed in the tenant
--   (#162, #165). The endpoint stayed healthy and returned a correct 401 to
--   unsigned requests the whole time, which is why "never installed" and "auth is
--   rejecting us" looked identical from our side.
--
--   This migration lands with the code that wrote the table. The bot route, the
--   Bot Framework client and the Office 365 Connector notification path all go in
--   the same change, so nothing is left that could write a row.
--
-- WHY NOT conversations.external_id TOO
--   It is on a table with 881 live rows and it is not Teams-specific: it is the
--   generic "this thread's id in some outside system" key. Nothing writes it now,
--   but it costs nothing to keep and dropping it would touch real data. It stays.
--
-- REVERSIBLE
--   Nothing is lost: the table is empty. Re-running the CREATE TABLE, the RLS
--   enable, the ops_all policy and the service_role grant from
--   20260624000001_agent_memory_phase1.sql restores the exact prior state.
-- ============================================================================

DROP TABLE IF EXISTS orchestration.teams_users;

-- patch/inbound-triage no longer accepts source = 'teams' and no longer posts
-- Teams cards; it triages email and notifies ops by email. Keep the registered
-- description honest about that.
UPDATE orchestration.orchestrations
   SET description = 'Triage inbound email: classify, extract action items, route or auto-respond'
 WHERE name = 'patch/inbound-triage';

-- cleo/content-nudge has emailed subscribers via sendAlertEmail since it was
-- written; only its registered description ever said "Teams alert" (20260709000005).
-- Correct it here rather than leave the last Teams reference in live data.
UPDATE orchestration.orchestrations
   SET description = 'Daily nudge: email alert for content-calendar posts due soon that are not yet drafted/ready.'
 WHERE name = 'cleo/content-nudge';
