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
  /**
   * The agent an internally-minted dispatch token was created FOR (#177).
   * NARROWING ONLY: routes/orchestrations.ts uses it to clamp knowledge retrieval to
   * that agent's declared corpora. No route may widen access based on it, and an
   * absent slug simply leaves the orchestration's own scope in place.
   */
  agentSlug?: string;
}

/** Pull the attribution-only `act_for` claim off a verified dispatch-token payload. */
function actForClaim(payload: Record<string, unknown>): { actFor?: string } {
  const raw = payload["act_for"];
  // Never let the reserved internal principal be echoed back as an end user.
  if (typeof raw !== "string" || raw === "" || raw === "agent-dispatch") return {};
  return { actFor: raw };
}

/**
 * Pull the narrowing-only `agent_slug` claim off a verified dispatch-token payload (#177).
 * Shape-checked against the same slug grammar the catalog enforces, so a malformed claim
 * degrades to "no caller scope" (the orchestration's own scope) rather than reaching a
 * database lookup.
 */
function agentSlugClaim(payload: Record<string, unknown>): { agentSlug?: string } {
  const raw = payload["agent_slug"];
  if (typeof raw !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(raw)) return {};
  return { agentSlug: raw };
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
      return { userId: "agent-dispatch", role: "ops", ...actForClaim(payload), ...agentSlugClaim(payload) };
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
      return { userId: "agent-dispatch", role: "ops", ...actForClaim(payload), ...agentSlugClaim(payload) };
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

// ─── zod → JSON Schema ─────────────────────────────────────────────────────────
// The dashboard run form is rendered entirely from this output, so it has to carry
// the authoring metadata (`.describe()`, `.default()`, `.min()`/`.max()`) through to
// the browser and not just the bare type — otherwise every describe() string written
// in orchestrations/**/definition.ts is discarded and the form falls back to raw
// property keys. See #128.

type JsonSchemaNode = Record<string, unknown>;

// The subset of zod's internal `_def` we read. Every field is optional, so the cast
// from ZodTypeDef is safe for any wrapper type.
interface ZodDefLike {
  description?: string;
  innerType?: z.ZodTypeAny;
  defaultValue?: () => unknown;
  schema?: z.ZodTypeAny;
}

interface Unwrapped {
  base: z.ZodTypeAny;
  description: string | undefined;
  defaultValue: unknown;
  hasDefault: boolean;
  nullable: boolean;
  optional: boolean;
}

/**
 * Peel the wrappers zod stacks around a base type. `.optional()`, `.default()` and
 * `.nullable()` each wrap the inner schema, and `.describe()` clones whatever it is
 * called on and hangs the description off that clone — so `z.string().optional()
 * .describe("…")` carries its description on the ZodOptional while `z.string()
 * .describe("…").optional()` carries it on the inner ZodString. Both the metadata
 * and the underlying type must therefore be collected on the way down.
 */
function unwrapSchema(schema: z.ZodTypeAny): Unwrapped {
  let cur: z.ZodTypeAny = schema;
  let description: string | undefined;
  let defaultValue: unknown;
  let hasDefault = false;
  let nullable = false;
  let optional = false;

  // Bounded: guards against a pathological/self-referential wrapper chain.
  for (let depth = 0; depth < 20; depth++) {
    const def = cur._def as ZodDefLike;
    if (description === undefined && typeof def.description === "string") {
      description = def.description;
    }
    if (cur instanceof z.ZodOptional) {
      optional = true;
      cur = cur.unwrap();
      continue;
    }
    if (cur instanceof z.ZodNullable) {
      nullable = true;
      cur = cur.unwrap();
      continue;
    }
    if (cur instanceof z.ZodDefault) {
      if (!hasDefault && typeof def.defaultValue === "function") {
        defaultValue = def.defaultValue();
        hasDefault = true;
      }
      cur = def.innerType as z.ZodTypeAny;
      continue;
    }
    if (cur instanceof z.ZodEffects) {
      cur = def.schema as z.ZodTypeAny;
      continue;
    }
    break;
  }

  return { base: cur, description, defaultValue, hasDefault, nullable, optional };
}

// True when a property may be omitted from the payload: `.optional()` or `.default()`
// anywhere in its wrapper chain. `.nullable()` alone still requires the key.
function isOmittable(schema: z.ZodTypeAny): boolean {
  const { optional, hasDefault } = unwrapSchema(schema);
  return optional || hasDefault;
}

function stringNode(base: z.ZodString, key?: string): JsonSchemaNode {
  const node: JsonSchemaNode = { type: "string" };
  let format: string | undefined;
  for (const check of base._def.checks) {
    if (check.kind === "min") node["minLength"] = check.value;
    else if (check.kind === "max") node["maxLength"] = check.value;
    else if (check.kind === "uuid") format ??= "uuid";
    else if (check.kind === "email") format ??= "email";
    else if (check.kind === "url") format ??= "uri";
    else if (check.kind === "datetime") format ??= "date-time";
  }
  // Base64 document payloads are file uploads in the UI, never something a human
  // types. The key name is the only reliable signal zod gives us.
  if (format === undefined && key !== undefined && /pdfbase64$/i.test(key)) format = "pdf-file";
  if (format !== undefined) node["format"] = format;
  return node;
}

function numberNode(base: z.ZodNumber): JsonSchemaNode {
  const node: JsonSchemaNode = { type: "number" };
  for (const check of base._def.checks) {
    if (check.kind === "min") node["minimum"] = check.value;
    else if (check.kind === "max") node["maximum"] = check.value;
  }
  return node;
}

function arrayNode(base: z.ZodArray<z.ZodTypeAny>, key?: string): JsonSchemaNode {
  const node: JsonSchemaNode = { type: "array", items: schemaToJsonSchema(base.element) };
  const def = base._def;
  if (def.minLength) node["minItems"] = def.minLength.value;
  if (def.maxLength) node["maxItems"] = def.maxLength.value;
  if (key !== undefined && /pdfbase64s$/i.test(key)) node["format"] = "pdf-files";
  return node;
}

function objectNode(base: z.ZodObject<z.ZodRawShape>): JsonSchemaNode {
  const shape = base.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, v] of Object.entries(shape)) {
    properties[k] = schemaToJsonSchema(v, k);
    if (!isOmittable(v)) required.push(k);
  }
  return { type: "object", properties, required };
}

function literalValue(schema: z.ZodTypeAny): string | undefined {
  if (schema instanceof z.ZodLiteral) return String(schema.value);
  if (schema instanceof z.ZodEnum) return (schema.options as string[])[0];
  return undefined;
}

/**
 * A discriminated union is rendered as a discriminator <select> that swaps the field
 * set beneath it, so the form needs the per-variant properties, not just `type:
 * "object"`. `oneOf` is the standard-JSON-Schema view (agent tool definitions read
 * this same output); `discriminator` + `variants` is the flattened view the form
 * consumes. The discriminator key itself is omitted from each variant's properties
 * because the selector supplies it.
 */
function discriminatedUnionNode(
  base: z.ZodDiscriminatedUnion<string, z.ZodDiscriminatedUnionOption<string>[]>,
): JsonSchemaNode {
  const discriminator = base._def.discriminator;
  const options = base.options as z.ZodObject<z.ZodRawShape>[];

  const variants = options.flatMap((option) => {
    const shape = option.shape as Record<string, z.ZodTypeAny>;
    const value = literalValue(shape[discriminator] as z.ZodTypeAny);
    if (value === undefined) return [];
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      if (k === discriminator) continue;
      properties[k] = schemaToJsonSchema(v, k);
      if (!isOmittable(v)) required.push(k);
    }
    const { description } = unwrapSchema(option);
    return [{
      value,
      ...(description !== undefined ? { description } : {}),
      properties,
      required,
    }];
  });

  return {
    type: "object",
    discriminator,
    variants,
    oneOf: options.map((option) => schemaToJsonSchema(option)),
    required: [discriminator],
  };
}

/**
 * Convert a zod schema to a JSON-Schema-shaped object for the catalogue API.
 * `key` is the property name when called for an object member; it is used only to
 * infer upload formats, which zod cannot express.
 */
export function schemaToJsonSchema(schema: z.ZodTypeAny, key?: string): Record<string, unknown> {
  const { base, description, defaultValue, hasDefault, nullable } = unwrapSchema(schema);

  let node: JsonSchemaNode;
  if (base instanceof z.ZodObject) node = objectNode(base as z.ZodObject<z.ZodRawShape>);
  else if (base instanceof z.ZodString) node = stringNode(base, key);
  else if (base instanceof z.ZodNumber) node = numberNode(base);
  else if (base instanceof z.ZodBoolean) node = { type: "boolean" };
  else if (base instanceof z.ZodArray) node = arrayNode(base as z.ZodArray<z.ZodTypeAny>, key);
  else if (base instanceof z.ZodEnum) node = { type: "string", enum: base.options as string[] };
  else if (base instanceof z.ZodLiteral) {
    const value = base.value as unknown;
    const literalType = typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
    node = { type: literalType, const: value, enum: [value] };
  } else if (base instanceof z.ZodDiscriminatedUnion) {
    node = discriminatedUnionNode(
      base as z.ZodDiscriminatedUnion<string, z.ZodDiscriminatedUnionOption<string>[]>,
    );
  } else if (base instanceof z.ZodUnion) {
    node = { anyOf: (base.options as z.ZodTypeAny[]).map((o) => schemaToJsonSchema(o)) };
  } else if (base instanceof z.ZodRecord) {
    node = { type: "object", additionalProperties: schemaToJsonSchema(base.valueSchema as z.ZodTypeAny) };
  } else {
    node = {};
  }

  if (nullable) node["nullable"] = true;
  if (description !== undefined) node["description"] = description;
  if (hasDefault) node["default"] = defaultValue;
  return node;
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
