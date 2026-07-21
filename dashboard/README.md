# LumiAgents Dashboard

Ops-facing Next.js app for the LumiAgents platform. Deployed on Cloudflare Workers via [opennextjs-cloudflare](https://github.com/opennextjs/opennextjs-cloudflare).

Live at: `https://lumiagents-dashboard.lumiture.workers.dev`

## What it does

| Section | Purpose |
|---|---|
| **Agents** | Chat with Angie, Beady, Patch, and Money; triggers orchestrations, attaches files |
| **Runs** | Live view of all orchestration runs with step-by-step status |
| **Orchestrations** | Browse available orchestrations, trigger ad-hoc runs |
| **Data** | Domain records (resume results, GovCon assessments, candidates, staff requests) |
| **Approvals** | Review and act on pending human-in-the-loop approval requests |
| **Documents** | Knowledge base ingestion and document management |
| **Schedules** | Manage cron-triggered orchestrations |
| **Infrastructure** | Cloudflare Worker health, deployment info, secrets |

## Local development

**Prerequisites:** Node 22+, pnpm 9+

```bash
# From the repo root:
pnpm install

# Create the env file:
cp dashboard/.env.local.example dashboard/.env.local   # or create manually (see below)

# Start the dev server:
cd dashboard && pnpm dev
```

Dashboard runs at `http://localhost:3000`. You also need the runtime running at `http://localhost:8787`; see the root README for `pnpm dev:all`.

### Required env vars (`dashboard/.env.local`)

| Key | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://cuaknazkpmwvnkmwtamp.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API → anon key |
| `NEXT_PUBLIC_RUNTIME_URL` | `http://localhost:8787` for local; prod URL for staging |

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CF_WORKER_SCRIPT_NAME` are only needed for the Infrastructure page (Cloudflare tail logs, metrics). The core app works without them locally.

## Building and deploying

CI deploys automatically on push to `main` when files under `dashboard/` change. To deploy manually:

```bash
cd dashboard

# Build for Cloudflare Workers:
NEXT_PUBLIC_RUNTIME_URL=https://lumiagents-runtime.lumiture.workers.dev \
NEXT_PUBLIC_SUPABASE_URL=https://cuaknazkpmwvnkmwtamp.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key> \
npx @opennextjs/cloudflare build

# Deploy:
npx wrangler deploy
```

`NEXT_PUBLIC_*` vars are baked into the client bundle at build time, so always set them explicitly when building for production.

## Key architecture notes

- **Auth:** Supabase Auth with RLS. The dashboard uses the anon key + user JWTs. It never uses the service role key.
- **Agent chat:** The browser calls `NEXT_PUBLIC_RUNTIME_URL/api/agents/:slug/chat` directly. The runtime mints a short-lived dispatch token server-side to authorize tool calls.
- **File batching:** When >20 files are attached, the dashboard splits them into batches of 20 and sends each as a separate agent chat request. The original user message is included in each batch so the LLM has full context.
- **Deployment runtime:** opennextjs-cloudflare, not Vercel. See `wrangler.toml` for the worker config.
