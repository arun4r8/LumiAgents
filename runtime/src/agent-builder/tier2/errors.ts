// Tier 2 agent builder (#67) — the shared validation error.
//
// It lives in its own module so the safety guards (guards.ts) can throw it without importing
// generate.ts, and generate.ts can import the guards. Before this split the two modules formed
// an import cycle, which is why generate.ts (the ONE kind whose file content a model writes) had
// never been wired to the guards at all. generate.ts re-exports it, so existing imports keep working.

/** Thrown when a spec — or a generated artifact — is invalid; the route maps it to a 400. */
export class Tier2ValidationError extends Error {
  readonly details: string[];
  constructor(details: string[]) {
    super(`Invalid capability spec: ${details.join("; ")}`);
    this.name = "Tier2ValidationError";
    this.details = details;
  }
}
