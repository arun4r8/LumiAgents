import { z } from "zod";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    const payload = parts[1];
    if (!payload) return null;
    const padded = payload.padEnd(payload.length + (4 - (payload.length % 4)) % 4, "=");
    const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function requireOpsToken(request: Request): { userId: string } | Response {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  const claims = decodeJwtClaims(auth.slice(7));
  if (!claims) {
    return new Response(JSON.stringify({ error: "Invalid token" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  if (claims["role"] !== "ops") {
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
