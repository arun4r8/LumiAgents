import { describe, it, expect } from "vitest";
import { RUNTIME_URL } from "./helpers";

describe("Runtime infrastructure", () => {
  it("health check returns ok", async () => {
    const res = await fetch(`${RUNTIME_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; orchestrations: number };
    expect(body.status).toBe("ok");
    expect(body.orchestrations).toBeGreaterThan(0);
  });

  it("orchestration catalogue is populated", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/orchestrations`);
    expect(res.status).toBe(200);
    const catalogue = await res.json() as unknown[];
    expect(catalogue.length).toBeGreaterThan(0);
  });

  it("catalogue entries have expected shape", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/orchestrations`);
    const catalogue = await res.json() as Array<{ name: string; triggerMode: string; access: unknown }>;
    for (const entry of catalogue) {
      expect(entry.name).toMatch(/^[a-z]+\//);
      expect(["manual", "agent"]).toContain(entry.triggerMode);
    }
  });

  it("unknown route returns 404", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/does-not-exist`);
    expect(res.status).toBe(404);
  });
});
