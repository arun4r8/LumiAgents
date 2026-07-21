# Agent database identity

How the six agents get a database identity of their own, so that agent data access is
enforced by Postgres rather than only by runtime code. Written 2026-07-21.

Status: **design agreed nowhere yet.** Phase 1 is implemented and merged inert. Nothing
in this document is switched on. A human must approve the direction before any of it is.

## The problem, verified

Every agent and every orchestration step talks to Supabase with
`SUPABASE_SERVICE_ROLE_KEY` (`runtime/src/db/client.ts`, `sbHeaders()` in
`runtime/src/agents/document-rag.ts`, the direct `fetch` calls in
`runtime/src/routes/helpers.ts`). `service_role` bypasses RLS by design. At the database
layer there is nothing that distinguishes Beady from Money, so:

- "Which agent may read which knowledge" is enforced in the retrieval path, not the
  database: `scopeForAgent()` in `runtime/src/agents/knowledge-access.ts` computes
  `{ allowedCorpora, includeRestricted }` and passes them as *arguments* to
  `orchestration.match_document_chunks`. The database applies whatever the caller asks
  for. A caller that omits the arguments gets everything, including `restricted`.
- That gate is applied inconsistently today. `orchestrations/patch/document-rag` and
  `orchestrations/dewey/knowledge-search` call `scopeForAgent`.
  `orchestrations/beady/govcon-assessment` hardcodes `allowed_corpora: ["shared","beady"]`
  in a raw `fetch` and never touches the helper. Nothing prevents the next orchestration
  from forgetting entirely. This is the concrete argument for moving the gate into the
  database: there is exactly one place to forget it, and it is not a place a feature PR
  touches.
- `match_document_chunks` is `SECURITY DEFINER`. RLS on `orch_documents` and
  `document_chunks` does **not** apply inside it. Adding RLS policies alone would not
  close the retrieval path. This shapes the design below more than anything else.

Human auth is unaffected and stays as documented in `docs/auth-model.md`: two enforced
roles, `ops` and `enduser`, checked by `public.is_ops()` in RLS and `requireOpsToken` in
the runtime. `role:analyst` and `role:hr` in orchestration `access` metadata remain
declarative only; this design does not change that.

## Options considered

### (a) A Postgres role per agent, RLS keyed on the role

Six `NOLOGIN` roles (`agent_beady`, `agent_money`, ...), policies written
`FOR SELECT TO agent_beady`, table-level `GRANT`s per role.

Strongest isolation available: real Postgres privilege separation, table and column
grants, nothing claim-based to forge. The repo already has the pattern in
`20260527000001_security_p0.sql`, where `analyst_ro` is a `NOLOGIN` least-privilege role
that `analyst_query` switches into with `SET LOCAL ROLE`.

Against it, decisively:

- The Workers reach Postgres over PostgREST, not a direct connection. PostgREST picks the
  Postgres role from the JWT `role` claim and does `SET LOCAL ROLE`. Using a custom role
  therefore requires `GRANT agent_beady TO authenticator` for each agent, plus a full
  parallel grant set (schema usage, table privileges, function execute) for each of six
  roles, on every table any agent might ever touch.
- Every existing policy in this repo is written `TO authenticated`. An `agent_beady`
  request would match none of them, so any table an agent needs would need a duplicate
  policy per role. Six roles times every table is a maintenance surface that will drift.
- It is the one option with a plausible way to break the live Data API for the four
  humans using it daily. A botched grant on `authenticator` is a project-wide outage, not
  a scoped failure.

Verdict: right mechanism, wrong layer. It stays useful *inside* `SECURITY DEFINER`
functions, exactly as `analyst_ro` is used, and that is where phase 3 should use it.

### (b) A signed JWT per agent carrying an `agent` claim (recommended)

The credential is an ordinary Supabase-shaped JWT with `role: "authenticated"` and an
extra custom claim `agent: "<slug>"`. Policies read it through
`public.current_agent()`, the agent-side mirror of `public.is_ops()`.

Why this one:

- **It is already how this repo does auth.** `public.is_ops()` reads a custom claim
  (`user_role`) that the access-token hook injects; policies never look at the Postgres
  role. `mintDispatchToken` in `runtime/src/routes/agents.ts` already signs an HS256 JWT
  with `SUPABASE_JWT_SECRET` for internal agent-to-orchestration calls. The agent
  credential is the same mechanism with one more claim. No new infrastructure.
- **It does not create a second auth model.** The Postgres role stays `authenticated` for
  humans and agents alike, so every existing `GRANT` and every existing `TO authenticated`
  policy keeps working untouched. There is one role axis (Postgres: `anon` /
  `authenticated` / `service_role`) and one principal axis expressed in claims
  (`user_role=ops`, `user_role=enduser`, `agent=<slug>`). The three principals are
  orthogonal and compose by OR, which is exactly how Postgres already combines permissive
  policies. Compare with (a), which would fork the role axis and force every policy to be
  written twice.
- **Additive by construction.** New policies are permissive, so they can only widen. New
  helper functions are new names. The existing retrieval RPC is untouched and a sibling is
  added beside it. Nothing that works today changes.
- **The kill switch is a row, not a deploy.** `agent_identities.is_active` gates
  `current_agent()`, so revoking every agent identity is one `UPDATE` with no rollout.

Against it: anyone holding `SUPABASE_JWT_SECRET` can mint any agent claim. That is a real
weakening compared to (a), but it is not a *regression*: the same secret already mints
`user_role: ops` dispatch tokens, and every one of these Workers already holds the
service role key, which is strictly more powerful than any agent claim. The agent
credential is a narrowing of the current position, not a widening.

### (c) Per-agent Supabase API keys or service accounts

Supabase has no first-class service-account concept. New secret API keys map to
`service_role`, which bypasses RLS and therefore solves nothing. The workable version is
six Supabase Auth *users* (`beady@agents.lumiture.internal` and so on) with
`app_metadata.agent = '<slug>'`, extended into the JWT by the existing
`custom_access_token_hook`, then signed in to obtain genuine Supabase-issued tokens.

That buys real per-agent issuance, per-agent revocation (disable the user), refresh-token
rotation, and compatibility with Supabase's asymmetric JWT signing keys. It costs six
synthetic rows in `auth.users` that show up in the ops user list, six sets of credentials
in Wrangler secrets, and a sign-in round trip on every token refresh.

The important point: **(c) is the same design as (b) with a different issuer.** The claim
shape is identical, so every policy, helper, and RPC written for (b) works unchanged if we
later swap the issuer. That is deliberate: the claim contract is the interface, the issuer
is an implementation detail.

## Recommendation

**Adopt (b).** Mint a short-lived per-agent JWT in the runtime, key RLS on
`public.current_agent()`, keep the Postgres role at `authenticated`.

Two riders:

1. Design the claim so **(c) is a drop-in issuer swap**, and make that swap the moment we
   need per-agent revocation or the project migrates to asymmetric JWT signing keys. Both
   are plausible within a year.
2. Keep **(a) for the inside of `SECURITY DEFINER` functions** in phase 3, following the
   `analyst_ro` precedent, where the JWT claim cannot reach.

### Open question that must be answered before switch-on

Supabase is migrating projects from a shared HS256 JWT secret to asymmetric signing keys.
If this project has already migrated, the Data API may reject HS256 tokens signed with
`SUPABASE_JWT_SECRET`, and the agent credential will simply fail to authenticate. The
existing comment in `requireOpsToken` ("works regardless of JWT secret format or key
system version") suggests this was already a live concern. This costs nothing to check
and it fails closed if wrong, but check it first:

```
curl -s "$SUPABASE_URL/rest/v1/rpc/current_agent" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer <token minted by mintAgentToken>" \
  -H "Content-Type: application/json" -d '{}'
```

Expect `null` before activation, `"dewey"` after. If it 401s, go straight to option (c).

## How a Worker obtains its credential

`runtime/src/agents/agent-identity.ts`:

```
mintAgentToken(jwtSecret, agentSlug, ttlSeconds = 300)
  -> HS256 JWT { sub, role: "authenticated", agent: <slug>, aud, iat, exp }

agentAuthHeaders(env, agentSlug)
  -> { apikey: SUPABASE_ANON_KEY ?? SUPABASE_SERVICE_ROLE_KEY,
       Authorization: "Bearer <token>" }
```

Notes that matter:

- **No new secret is distributed.** The Worker already holds `SUPABASE_JWT_SECRET`. Tokens
  are minted per call, in process, and never stored.
- **`sub` is the nil uuid**, not the slug. `auth.uid()` is `(auth.jwt() ->> 'sub')::uuid`,
  and several existing enduser policies call it. A non-uuid subject would make those
  policies raise a cast error on any agent request that touched such a table. The nil uuid
  parses cleanly and matches no user row. The identity lives in the `agent` claim.
- **`apikey` only gets the request past the API gateway.** The Postgres role and the agent
  claim both come from the Authorization JWT. Setting `SUPABASE_ANON_KEY` is cleaner but
  is not required for correctness.
- **TTL is 300s**, matching the existing dispatch token.

### Rotation

| What | How | Blast radius |
|------|-----|--------------|
| A single agent's access | `UPDATE orchestration.agent_identities SET is_active = false WHERE agent_slug = ...` | That agent only, effective immediately, no deploy |
| All agent access | Same `UPDATE` without the `WHERE` | All agents, no deploy, humans unaffected |
| The signing key | Rotate `SUPABASE_JWT_SECRET` | **Project-wide.** Invalidates dashboard sessions and the dispatch-token path at the same time |

The third row is the honest limitation of (b): with a shared signing secret there is no
per-agent *key* rotation, only per-agent *authorisation* revocation. In practice the
`is_active` switch covers the operational need (an agent misbehaving, a corpus
mis-tagged) and key rotation is a project-wide security event anyway. If per-agent key
rotation becomes a hard requirement, that is the trigger to move to option (c), where each
agent has its own refresh token.

## Migrating the corpus/sensitivity gate

The gate exists in one place today: the `allowed_corpora` and `include_restricted`
arguments to `orchestration.match_document_chunks`, chosen by the caller.

Because that function is `SECURITY DEFINER`, policies on the underlying tables do not
apply inside it, so the migration is not "add RLS and delete the arguments". It is:

1. `orchestration.agent_identities` becomes the source of truth for each agent's scope,
   seeded to match `scopeForAgent()` exactly (shared corpus plus own, no `restricted`).
   Activating an agent therefore changes *who enforces* the scope, not *what* the scope is.
2. `public.agent_may_read(corpus, sensitivity)` expresses the predicate once.
3. `agent_read_scoped` permissive `SELECT` policies on `orch_documents` and
   `document_chunks` apply that predicate.
4. `orchestration.match_document_chunks_for_agent` is a **`SECURITY INVOKER`** sibling. It
   runs as `authenticated`, so the policies above are what actually filter rows. It takes
   no `include_restricted` argument at all and derives everything from the identity.
5. It raises if `current_agent()` is `NULL`, so a `service_role` caller fails loudly rather
   than quietly receiving an unfiltered result set. That failure mode is the entire reason
   this work exists, so it must not be reachable by accident.

The original `match_document_chunks` is left byte-identical. Every current caller keeps
working, including the ops/dashboard path in `runtime/src/routes/documents.ts` that
deliberately passes `OPS_SCOPE` (no corpus restriction, restricted included). That path is
a human ops path and should stay service-role; it is not an agent.

### Belt and braces during transition: yes

Both gates should run for the whole transition, and the implementation makes that the
default rather than an option.

`match_document_chunks_for_agent` takes `narrow_to_corpora`, and the runtime keeps
computing `scopeForAgent()` and passes it there. Because the database scope is applied by
RLS regardless, `narrow_to_corpora` can only intersect, never widen. So:

- if the runtime gate is right and the database gate is right, the result is unchanged;
- if the runtime gate is forgotten in some new code path, the database gate still holds;
- if the database scope is mis-seeded too wide, the runtime gate still holds.

Only after the database gate has been observed correct in production for a full cycle
should `scopeForAgent()` stop being passed. Removing the runtime gate is explicitly **not**
part of phase 1 and should be its own PR.

## Cutover plan

Each step is independently reversible and none of them require a deploy except step 2.

0. **Merged, inert.** The migration applies. All six identities are `is_active = false`,
   `AGENT_DB_IDENTITY` is unset. `current_agent()` returns `NULL` for everything, the new
   policies match no rows, the new RPC refuses to run. Behaviour is unchanged.
1. **Verify the credential authenticates.** Run the `curl` above against staging. If it
   401s, stop and reconsider the issuer (option (c)).
2. **Set `AGENT_DB_IDENTITY=enforce`** on the runtime Worker. Still inert: every identity
   is inactive, so any agent-attributed retrieval would raise. Do this on staging first,
   with `dewey` activated (step 3) in the same window.
3. **Activate one agent.** `UPDATE ... SET is_active = true WHERE agent_slug = 'dewey'`.
   Dewey is the right first candidate: it is the knowledge librarian, its retrieval path
   goes through `scopeForAgent`, and it runs inline in the runtime rather than in its own
   Worker, so there is one deployment surface.
4. **Compare.** For a set of known questions, the answer set under the agent identity must
   equal the answer set under the runtime gate. Any divergence is a mis-seeded
   `allowed_corpora`, and it is a data fix, not a code fix.
5. **Activate `patch`**, then wire and activate the remaining agents one at a time.
   `beady/govcon-assessment` needs its raw `fetch` moved onto the shared retrieval path
   first; that is a prerequisite for Beady, not a blocker for anyone else.
6. **Only then** consider removing the runtime gate, in its own PR, with its own review.

## Rollback plan

Ordered from cheapest to most invasive. In practice the first line is enough.

1. `UPDATE orchestration.agent_identities SET is_active = false;`
   Immediate, no deploy, no restart. `current_agent()` returns `NULL`, the new policies
   match nothing, the new RPC raises. Any agent-attributed retrieval fails closed, which
   is the correct direction to fail.
2. Unset `AGENT_DB_IDENTITY` on the Worker and redeploy. Retrieval returns to the exact
   previous code path, service role plus runtime gate.
3. Full teardown: the `DROP` sequence in the migration header. Because the migration
   altered nothing pre-existing, nothing needs restoring afterwards. This is the meaningful
   payoff of doing it additively.

There is no scenario in which rolling back loses data or leaves a table without a policy.

## What is deliberately not attempted

Named here rather than half-done.

- **Removing `service_role`.** Not additive by definition. All writes (`SupabaseClient`,
  the run/step/tool-call telemetry, every domain-table write) stay on the service role.
  Phase 1 gives agents a *read* identity for knowledge only.
- **Per-agent write policies on the domain tables.** Adding the policies is additive, but
  they are meaningless while writes go through `service_role`, and converting writes means
  re-authenticating every write path in the runtime and getting a `WITH CHECK` right on
  ~25 tables. That is phase 2 and it deserves its own design.
- **The analyst NL to SQL path.** `orchestration.analyst_query` is `SECURITY DEFINER` and
  sets `ROLE analyst_ro`, which is `BYPASSRLS`. No agent RLS constrains it, so Money's SQL
  path is unaffected by any of this. The additive fix is a per-agent read-only role in the
  `analyst_ro` mould, chosen from `current_agent()`. This is exactly where option (a)
  belongs and it is phase 3.
- **Agent memory.** `orchestration.match_memory` is `SECURITY DEFINER` scoped by
  `(user_id, agent_slug)` passed as arguments, the same runtime-trust pattern as
  retrieval. It should get the same treatment once the retrieval pattern is proven, but
  doing both at once doubles the surface under test for no extra safety.
- **Custom Postgres roles in the JWT `role` claim.** Judged not safely additive: it needs
  `GRANT ... TO authenticator` and a parallel grant set, and a mistake there breaks the
  Data API for the four humans using this daily. See option (a).
- **Enforcing `role:analyst` and `role:hr`.** Out of scope. They remain declarative, as
  `docs/auth-model.md` says.

## Reference: what shipped in phase 1

`supabase/migrations/20260721000010_agent_identities.sql`

- `orchestration.agent_identities` (+ RLS in the same migration, per repo convention),
  seeded with all six agents, every one `is_active = false`
- `public.current_agent()`, `public.agent_may_read(text, text)`,
  `public.agent_may_read_document(uuid)`
- `agent_read_scoped` permissive `SELECT` policies on `orchestration.orch_documents` and
  `orchestration.document_chunks`
- `orchestration.match_document_chunks_for_agent(...)`, `SECURITY INVOKER`, not granted to
  `service_role`

`runtime/src/agents/agent-identity.ts`

- `mintAgentToken`, `agentAuthHeaders`, `isAgentDbIdentityEnabled`

`runtime/src/agents/document-rag.ts`

- optional `agentSlug` on `QueryRequest`; when set *and* `AGENT_DB_IDENTITY=enforce`,
  retrieval uses the agent credential and the new RPC. Otherwise the previous path,
  unchanged.

`orchestrations/dewey/knowledge-search`, `orchestrations/patch/document-rag`

- pass their slug. Inert while the switch is off.

Not changed: `SUPABASE_SERVICE_ROLE_KEY` usage anywhere, `public.is_ops()`, any existing
RLS policy, `orchestration.match_document_chunks`, `scopeForAgent`, `OPS_SCOPE`.
