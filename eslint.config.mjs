import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "**/dist/**", "contracts/**", "scripts/*.py", "packages/contracts/src/brain.generated.ts", "packages/contracts/src/ports.ts", "review.browser.mjs", "review.phase2.mjs", "review.phase3.mjs"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
