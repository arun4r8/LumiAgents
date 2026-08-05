import { z } from "zod";
import type { Env } from "../types";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function base64UrlToBytes(b64: string): Uint8Array {
  const padded = b64.padEnd(b64.length + (4 - (b64.length % 4)) % 4, "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function verifyJwt(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(parts[1]!)),
    ) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload["exp"] === "number" && payload["exp"] < now) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * The authenticated principal a route is acting as.
 *
 * `userId` + `role` are the ONLY authorization inputs. `actFor` is attribution-only
 * (#127): it carries the id of the real end user on whose behalf an internally-minted
 * agent-dispatch token was created, so a run started through agent chat can be stamped
 * with `triggered_by_user_id` and become visible to that user under the enduser RLS
 * policy (`triggered_by_user_id = auth.uid()`). It grants nothing — the principal is
 * still `agent-dispatch` with role `ops`, and no route may widen access based on it.
 */
export interface AuthPrincipal {
  userId: string;
  role: string;
  actFor?: string;
}

/** Pull the attribution-only `act_for` claim off a verified dispatch-token payload. */
function actForClaim(payload: Record<string, unknown>): { actFor?: string } {
  const raw = payload["act_for"];
  // Never let the reserved internal principal be echoed back as an end user.
  if (typeof raw !== "string" || raw === "" || raw === "agent-dispatch") return {};
  return { actFor: raw };
}

export async function requireOpsToken(
  request: Request,
  env: Env,
): Promise<AuthPrincipal | Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
  const token = auth.slice(7);

  // Primary: verify via Supabase Auth endpoint, which works regardless of JWT secret format
  // or key system version. The service role key is used as the apikey header (not the
  // user token) so Supabase trusts the request to read any user's profile.
  try {
    const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (userRes.ok) {
      const user = await userRes.json() as { id: string; app_metadata?: { role?: string } };
      const role = user.app_metadata?.["role"];
      if (role !== "ops") return json({ error: "Forbidden: ops role required" }, 403);
      return { userId: user.id, role };
    }
  } catch {
    // network error: fall through
  }

  // Secondary: internally-minted dispatch tokens (agent → orchestration calls).
  // Signed with SUPABASE_JWT_SECRET; must carry sub: "agent-dispatch" so external
  // JWTs with the same key cannot be misused as service tokens.
  if (env.SUPABASE_JWT_SECRET) {
    const payload = await verifyJwt(token, env.SUPABASE_JWT_SECRET);
    if (payload?.["sub"] === "agent-dispatch") {
      // `act_for` is surfaced for attribution only; the principal stays agent-dispatch/ops.
      return { userId: "agent-dispatch", role: "ops", ...actForClaim(payload) };
    }
  }

  return json({ error: "Invalid token" }, 401);
}

/**
 * Authenticate any signed-in user (ops OR enduser) and return their id + role.
 * Use this on surfaces endusers are allowed to reach (agent chat, orchestration
 * runs, document upload). It does NOT require ops — callers that need ops-only
 * behavior must use requireOpsToken. Internally-minted agent-dispatch tokens are
 * accepted as a trusted principal (role "ops"), and their attribution-only `act_for`
 * claim is surfaced as `actFor` (see AuthPrincipal).
 */
export async function requireUser(
  request: Request,
  env: Env,
): Promise<AuthPrincipal | Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
  const token = auth.slice(7);

  // Primary: verify the bearer against Supabase Auth (any authenticated user).
  try {
    const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (userRes.ok) {
      const user = await userRes.json() as { id: string; app_metadata?: { role?: string } };
      const role = user.app_metadata?.["role"] ?? "enduser";
      return { userId: user.id, role };
    }
  } catch {
    // network error: fall through
  }

  // Secondary: internally-minted agent-dispatch tokens (trusted).
  if (env.SUPABASE_JWT_SECRET) {
    const payload = await verifyJwt(token, env.SUPABASE_JWT_SECRET);
    if (payload?.["sub"] === "agent-dispatch") {
      return { userId: "agent-dispatch", role: "ops", ...actForClaim(payload) };
    }
  }

  return json({ error: "Invalid token" }, 401);
}

export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

export function schemaToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = schemaToJsonSchema(v);
      if (!(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault)) required.push(k);
    }
    return { type: "object", properties, required };
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray) return { type: "array", items: schemaToJsonSchema(schema.element) };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options as string[] };
  if (schema instanceof z.ZodOptional) return schemaToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return schemaToJsonSchema(schema._def.innerType as z.ZodTypeAny);
  if (schema instanceof z.ZodNullable) return { ...schemaToJsonSchema(schema.unwrap()), nullable: true };
  if (schema instanceof z.ZodDiscriminatedUnion) return { type: "object" };
  return {};
}

// ─── Per-user rate limiting (fixed window via claim_rate_limit RPC) ─────────────
// Fails OPEN, because a metrics/db outage must not lock users out. Internal
// agent-dispatch calls are bounded by MAX_TOOL_ROUNDS, so they're never throttled.
export async function claimRateLimit(
  env: Env, userId: string, bucket: string, limit: number, windowSeconds = 60,
): Promise<boolean> {
  if (userId === "agent-dispatch") return true;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/claim_rate_limit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ p_user: userId, p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds }),
    });
    if (!res.ok) return true;
    return (await res.json()) as boolean;
  } catch {
    return true;
  }
}

// Returns a 429 Response if the caller is over the limit, else null.
export async function rateLimited(
  env: Env, userId: string, bucket: string, limit: number, windowSeconds = 60,
): Promise<Response | null> {
  const ok = await claimRateLimit(env, userId, bucket, limit, windowSeconds);
  return ok ? null : json({ error: `Rate limit exceeded: max ${limit} ${bucket} requests per ${windowSeconds}s.` }, 429);
}
