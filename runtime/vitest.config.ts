import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const runtimeSrc = fileURLToPath(new URL("./src", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Unit tests live under runtime/tests but import pure modules from ../orchestrations
// and ../integrations, which use the `@/runtime/*` path alias. Vitest (Vite) does not
// read tsconfig `paths`, so map the alias here and widen fs access to the repo root.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\/runtime$/, replacement: `${runtimeSrc}/index.ts` },
      { find: /^@\/runtime\/(.*)$/, replacement: `${runtimeSrc}/$1` },
    ],
  },
  server: {
    fs: { allow: [repoRoot] },
  },
});
