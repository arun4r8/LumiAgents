-- patch/vault-sync is webhook-triggered (GitHub push), not user-triggered.
-- Move it out of the user-facing orchestrations catalog by setting trigger_mode = 'webhook'.
-- The runtime still looks it up by name for /api/vault/sync and /api/vault/webhook dispatch.

UPDATE orchestration.orchestrations
SET trigger_mode = 'webhook'
WHERE name = 'patch/vault-sync';
