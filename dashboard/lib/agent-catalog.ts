// Tier 1 agent builder (#67) — server-side helpers for the catalog-driven agents list and
// the config-agent edit round-trip. The card catalogue (code ∪ config) is read from the
// runtime's open GET /api/agents (service_role behind it), so endusers can see every card
// even though the orchestration.agents table is ops-only for direct reads (RLS). Editing a
// config agent (loading its manifest, saving) happens via the ops user's Supabase client,
// which passes the ops_all policy.

import { readOnlyOrchestrations } from "../../runtime/src/agents/catalog-validation";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

export interface AgentCard {
  slug: string;
  name: string;
  emoji: string;
  category: string;
  description: string;
  suggestedPrompts: string[];
  source: "code" | "config";
  lifecycle: "active" | "disabled";
}

interface RawCatalogAgent {
  slug: string;
  displayName: string;
  card: {
    emoji?: string;
    category?: string;
    description?: string;
    suggestedPrompts?: string[];
  } | null;
  source: "code" | "config";
  lifecycle: "active" | "disabled";
}

function toCard(r: RawCatalogAgent): AgentCard {
  const c = r.card ?? {};
  return {
    slug: r.slug,
    name: r.displayName,
    emoji: c.emoji ?? "🤖",
    category: c.category ?? "Agent",
    description: c.description ?? "",
    suggestedPrompts: Array.isArray(c.suggestedPrompts) ? c.suggestedPrompts : [],
    source: r.source,
    lifecycle: r.lifecycle,
  };
}

/** Map a raw orchestration.agents DB row (snake_case) to an AgentCard. Pure — safe to import
 *  from server components that read the catalog directly via the service-role admin client
 *  (reliable in server-render, unlike a cross-worker fetch that needs a session token). */
export function cardFromRow(r: {
  slug: string;
  display_name: string;
  card: RawCatalogAgent["card"];
  source: "code" | "config";
  lifecycle: "active" | "disabled";
}): AgentCard {
  return toCard({ slug: r.slug, displayName: r.display_name, card: r.card, source: r.source, lifecycle: r.lifecycle });
}

/** All agent cards (code ∪ config) from the runtime catalogue. Empty on any failure so the
 *  list page degrades gracefully rather than erroring. */
export async function getAgentCards(token?: string): Promise<AgentCard[]> {
  try {
    const res = await fetch(`${RUNTIME}/api/agents`, {
      cache: "no-store",
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as RawCatalogAgent[];
    return rows.map(toCard);
  } catch {
    return [];
  }
}

/** One agent card by slug (code or config), or null. */
export async function getAgentCard(slug: string, token?: string): Promise<AgentCard | null> {
  const cards = await getAgentCards(token);
  return cards.find((c) => c.slug === slug) ?? null;
}

// ─── The orchestration tool catalogue (for the composer's tool picker) ──────────

export interface OrchestrationOption {
  name: string;
  description: string | null;
  isActive: boolean;
  /** Provably read-only (a code agent runs it sync) → may be wired as mode:'sync'. */
  syncEligible: boolean;
}

interface RawOrchestration {
  name: string;
  description: string | null;
}

/**
 * The orchestration catalogue for the tool picker: the runtime registry (GET
 * /api/orchestrations) joined with the DB's is_active flag. `syncEligible` reuses the exact
 * read-only set the runtime validator derives from the code agents' sync toolMaps, so the
 * composer's "sync" toggle is offered only where validateConfigAgent() would accept it.
 */
export async function getOrchestrationOptions(
  isActiveByName: Map<string, boolean>,
): Promise<OrchestrationOption[]> {
  const readOnly = readOnlyOrchestrations();
  try {
    const res = await fetch(`${RUNTIME}/api/orchestrations`, { cache: "no-store" });
    if (!res.ok) return [];
    const rows = (await res.json()) as RawOrchestration[];
    return rows.map((o) => ({
      name: o.name,
      description: o.description,
      isActive: isActiveByName.get(o.name) ?? true,
      syncEligible: readOnly.has(o.name),
    }));
  } catch {
    return [];
  }
}
