import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  // No em dashes in anything that renders.
  //
  // This has been swept twice (#49, then #152 sixteen days later, by which point
  // 267 had accumulated again). A sweep does not hold on its own, so the rule is
  // the actual fix and the sweep was just the backfill.
  //
  // Deliberately AST-scoped rather than a text grep: it fires on string literals,
  // template chunks and JSX text — the three ways a character reaches the DOM —
  // and cannot fire on a comment, because comments are not AST nodes. Prose in
  // comments is left alone on purpose; only shipped copy is covered.
  //
  // Not applied at the repo root: runtime/src/agent-builder/** puts em dashes in
  // generated-file headers and GitHub PR bodies, which are not UI.
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Same convention as the repo-root config: a leading underscore marks an
      // argument that is deliberately unused (route handlers that ignore the request).
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],

      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/—/]",
          message:
            "No em dash (—) in user-visible copy. Use a period for two independent clauses, " +
            "a colon before a list or definition, parentheses for an aside, or · as a separator. " +
            "For a missing value use \"-\", matching fmtAbs/fmtDuration in components/lumi.tsx.",
        },
        {
          selector: "TemplateElement[value.raw=/—/]",
          message:
            "No em dash (—) in user-visible copy. Use a period for two independent clauses, " +
            "a colon before a list or definition, parentheses for an aside, or · as a separator.",
        },
        {
          selector: "JSXText[value=/—/]",
          message:
            "No em dash (—) in user-visible copy. Use a period for two independent clauses, " +
            "a colon before a list or definition, parentheses for an aside, or · as a separator.",
        },
      ],
    },
  },
]);

export default eslintConfig;
