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

export async function requireOpsToken(
  request: Request,
  env: Env,
): Promise<{ userId: string } | Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  const claims = await verifyJwt(auth.slice(7), env.SUPABASE_JWT_SECRET);
  if (!claims) {
    return new Response(JSON.stringify({ error: "Invalid token" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  // Check top-level role claim (present when JWT hook is enabled) OR app_metadata.role
  // (present when hook is disabled). Mirrors public.is_ops() in the database.
  const appMeta = claims["app_metadata"] as Record<string, unknown> | undefined;
  const role = claims["role"] ?? appMeta?.["role"];
  if (role !== "ops") {
    return new Response(JSON.stringify({ error: "Forbidden — ops role required" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    });
  }
  return { userId: claims["sub"] as string };
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
