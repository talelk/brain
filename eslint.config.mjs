import tseslint from "typescript-eslint";
import solid from "eslint-plugin-solid";
import importX from "eslint-plugin-import-x";
import security from "eslint-plugin-security";
import unusedImports from "eslint-plugin-unused-imports";

export default tseslint.config(
  { ignores: ["node_modules/**", "**/dist/**", "artifacts/**", "contracts/**", "examples/**", "scripts/*.py", "packages/contracts/src/brain.generated.ts", "packages/contracts/src/ports.ts", "review.browser.mjs", "review.phase2.mjs", "review.phase3.mjs", "review.*.mjs"] },
  ...tseslint.configs.recommended,
  solid.configs.recommended,
  security.configs.recommended,
  {
    files: ["**/*.mjs"],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "import-x": importX, "unused-imports": unusedImports },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "off",
      "import-x/no-cycle": "off",
      "import-x/no-self-import": "error",
      "import-x/no-useless-path-segments": "error",
      "solid/reactivity": "off",
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-object-injection": "off",
      "security/detect-non-literal-regexp": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
);
