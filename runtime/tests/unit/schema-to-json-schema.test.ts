import { describe, it, expect } from "vitest";
import { z } from "zod";
import { schemaToJsonSchema } from "../../src/routes/helpers";
import { orchestrations } from "../../src/registry";

// #128: the dashboard run form renders entirely from this output. Before this pass it
// emitted only type/enum/nullable/items/required, so every `.describe()` string in
// orchestrations/**/definition.ts was discarded on the way to the browser and
// z.discriminatedUnion collapsed to a bare {type:"object"} that could never be filled in.

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  discriminator?: string;
  variants?: { value: string; properties: Record<string, Record<string, unknown>>; required: string[] }[];
  oneOf?: Record<string, unknown>[];
}

const toSchema = (schema: z.ZodTypeAny): JsonSchemaObject =>
  schemaToJsonSchema(schema) as JsonSchemaObject;

describe("schemaToJsonSchema — metadata", () => {
  it("carries .describe() through an .optional() wrapper", () => {
    const out = toSchema(z.object({
      location: z.string().optional().describe("Preferred location (e.g. 'Remote')"),
    }));
    expect(out.properties?.["location"]).toEqual({
      type: "string",
      description: "Preferred location (e.g. 'Remote')",
    });
    expect(out.required).toEqual([]);
  });

  it("carries .describe() written before the wrapper too", () => {
    const out = toSchema(z.object({
      notes: z.string().describe("Extra analyst context").optional(),
    }));
    expect(out.properties?.["notes"]?.["description"]).toBe("Extra analyst context");
    expect(out.required).toEqual([]);
  });

  it("emits default and description for a .default().describe() number", () => {
    const out = toSchema(z.object({
      maxCandidates: z.number().int().min(1).max(25).default(10).describe("Max candidates to surface"),
    }));
    expect(out.properties?.["maxCandidates"]).toEqual({
      type: "number",
      minimum: 1,
      maximum: 25,
      default: 10,
      description: "Max candidates to surface",
    });
    // A field with a default is never required.
    expect(out.required).toEqual([]);
  });

  it("emits minimum/maximum on numbers and minLength on strings", () => {
    const out = toSchema(z.object({
      score: z.number().min(1).max(10),
      jobDescription: z.string().min(50).max(4000),
    }));
    expect(out.properties?.["score"]).toMatchObject({ minimum: 1, maximum: 10 });
    expect(out.properties?.["jobDescription"]).toMatchObject({ minLength: 50, maxLength: 4000 });
    expect(out.required).toEqual(["score", "jobDescription"]);
  });

  it("derives a format where zod declares one, and for base64 upload fields", () => {
    const out = toSchema(z.object({
      opportunityId: z.string().uuid().optional(),
      receivedAt: z.string().datetime().optional(),
      solicitationPdfBase64: z.string().optional().describe("Base64 solicitation PDF"),
      pdfBase64s: z.array(z.string()).min(1),
    }));
    expect(out.properties?.["opportunityId"]?.["format"]).toBe("uuid");
    expect(out.properties?.["receivedAt"]?.["format"]).toBe("date-time");
    expect(out.properties?.["solicitationPdfBase64"]?.["format"]).toBe("pdf-file");
    expect(out.properties?.["pdfBase64s"]?.["format"]).toBe("pdf-files");
  });

  it("keeps nullable and unwraps it to the base type", () => {
    const out = toSchema(z.object({ assignee: z.string().nullable().describe("May be unassigned") }));
    expect(out.properties?.["assignee"]).toEqual({
      type: "string",
      nullable: true,
      description: "May be unassigned",
    });
  });
});

describe("schemaToJsonSchema — types", () => {
  it("emits an enum with its description and default", () => {
    const out = toSchema(z.object({
      channel: z.enum(["linkedin", "instagram"]).default("linkedin").describe("Social channel to draft for"),
    }));
    expect(out.properties?.["channel"]).toEqual({
      type: "string",
      enum: ["linkedin", "instagram"],
      default: "linkedin",
      description: "Social channel to draft for",
    });
  });

  it("emits arrays with item type, bounds and defaults", () => {
    const out = toSchema(z.object({
      naicsCodes: z.array(z.string()).default(["541512"]).describe("NAICS codes for the SAM.gov filter"),
      pdfBase64s: z.array(z.string()).min(1).max(20),
    }));
    expect(out.properties?.["naicsCodes"]).toEqual({
      type: "array",
      items: { type: "string" },
      default: ["541512"],
      description: "NAICS codes for the SAM.gov filter",
    });
    expect(out.properties?.["pdfBase64s"]).toMatchObject({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 20,
      format: "pdf-files",
    });
  });

  it("emits booleans with their default so the checkbox starts in the right state", () => {
    const out = toSchema(z.object({
      requireClearance: z.boolean().default(false).describe("Keyword-search for clearance holders"),
      notifyTeams: z.boolean().default(true),
    }));
    expect(out.properties?.["requireClearance"]).toEqual({
      type: "boolean",
      default: false,
      description: "Keyword-search for clearance holders",
    });
    expect(out.properties?.["notifyTeams"]).toEqual({ type: "boolean", default: true });
  });

  it("emits records as an open object", () => {
    const out = toSchema(z.object({ metadata: z.record(z.string()).optional().describe("Tags") }));
    expect(out.properties?.["metadata"]).toEqual({
      type: "object",
      additionalProperties: { type: "string" },
      description: "Tags",
    });
  });
});

describe("schemaToJsonSchema — discriminated unions", () => {
  const union = z.discriminatedUnion("operation", [
    z.object({
      operation: z.literal("create"),
      requestText: z.string().min(10).describe("What needs doing"),
      notifyTeams: z.boolean().default(true).describe("Post a Teams card"),
    }),
    z.object({
      operation: z.literal("search"),
      jql: z.string().describe("JQL query string"),
      maxResults: z.number().int().min(1).max(50).default(20),
    }),
  ]);

  it("emits a discriminator plus one variant per branch", () => {
    const out = toSchema(union);
    expect(out.type).toBe("object");
    expect(out.discriminator).toBe("operation");
    expect(out.required).toEqual(["operation"]);
    expect(out.variants?.map((v) => v.value)).toEqual(["create", "search"]);
  });

  it("gives each variant its own fields, metadata and required list", () => {
    const out = toSchema(union);
    const create = out.variants?.find((v) => v.value === "create");
    expect(create?.properties).toEqual({
      requestText: { type: "string", minLength: 10, description: "What needs doing" },
      notifyTeams: { type: "boolean", default: true, description: "Post a Teams card" },
    });
    // The discriminator itself is supplied by the selector, not by a field.
    expect(create?.properties["operation"]).toBeUndefined();
    expect(create?.required).toEqual(["requestText"]);

    const search = out.variants?.find((v) => v.value === "search");
    expect(search?.required).toEqual(["jql"]);
    expect(search?.properties["maxResults"]).toMatchObject({ minimum: 1, maximum: 50, default: 20 });
  });

  it("also emits a standard oneOf, since agent tool definitions read the same output", () => {
    const out = toSchema(union);
    expect(out.oneOf).toHaveLength(2);
    expect(out.oneOf?.[0]).toMatchObject({
      type: "object",
      required: ["operation", "requestText"],
    });
  });
});

describe("schemaToJsonSchema — real orchestration definitions", () => {
  it("gives every registered input property a description", () => {
    const missing: string[] = [];
    for (const [name, orch] of orchestrations) {
      const schema = toSchema(orch.inputSchema);
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        if (typeof prop["description"] !== "string") missing.push(`${name}.${key}`);
      }
      for (const variant of schema.variants ?? []) {
        for (const [key, prop] of Object.entries(variant.properties)) {
          if (typeof prop["description"] !== "string") missing.push(`${name}[${variant.value}].${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("makes patch/ticket-ops renderable instead of 'no inputs required'", () => {
    const out = toSchema(orchestrations.get("patch/ticket-ops")!.inputSchema);
    expect(out.discriminator).toBe("operation");
    expect(out.variants?.map((v) => v.value)).toEqual(["create", "update", "search"]);
  });

  it("carries beady/opportunity-sweep array defaults and angie/candidate-sourcing bounds", () => {
    // Asserts the CONVERSION carries an array default, not which codes are in it.
    // The NAICS list is a business tuning knob (#205 dropped 541330 and added
    // 518210/541611); pinning its contents here made an unrelated test fail on a
    // schedule change and taught nothing about schema conversion.
    const sweepDef = orchestrations.get("beady/opportunity-sweep")!;
    const sweep = toSchema(sweepDef.inputSchema);
    const declaredDefault = (sweepDef.inputSchema as z.ZodObject<z.ZodRawShape>).shape["naicsCodes"]
      ?._def.defaultValue() as string[];
    expect(sweep.properties?.["naicsCodes"]).toMatchObject({
      type: "array",
      default: declaredDefault,
    });
    expect(declaredDefault.length).toBeGreaterThan(0);
    expect(declaredDefault.every((c) => /^\d{6}$/.test(c))).toBe(true);

    const sourcing = toSchema(orchestrations.get("angie/candidate-sourcing")!.inputSchema);
    expect(sourcing.properties?.["maxCandidates"]).toMatchObject({ minimum: 1, maximum: 25, default: 10 });
    expect(sourcing.properties?.["requireClearance"]).toMatchObject({ type: "boolean", default: false });
    expect(sourcing.required).toEqual(["jobTitle", "jobDescription"]);
  });
});
