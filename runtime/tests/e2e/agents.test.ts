import { describe, it, expect } from "vitest";
import { RUNTIME_URL } from "./helpers";

const AGENTS = ["angie", "beady", "patch", "money"] as const;

describe("Agent chat endpoints", () => {
  for (const slug of AGENTS) {
    it(`${slug} responds to a greeting`, async () => {
      const res = await fetch(`${RUNTIME_URL}/api/agents/${slug}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hi, what can you help me with?" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { reply: string };
      expect(typeof body.reply).toBe("string");
      expect(body.reply.length).toBeGreaterThan(10);
    }, 30_000);
  }
});
