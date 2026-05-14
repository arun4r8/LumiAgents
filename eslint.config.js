// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Ignore dirs with their own configs or generated output
  { ignores: ["dashboard/", "node_modules/", "**/*.js", "**/*.mjs"] },

  ...tseslint.configs.recommended,

  {
    files: ["agents/**/*.ts", "runtime/src/**/*.ts", "orchestrations/**/*.ts", "integrations/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
