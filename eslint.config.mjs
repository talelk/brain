import tseslint from "typescript-eslint";
import solid from "eslint-plugin-solid";
import importX from "eslint-plugin-import-x";
import security from "eslint-plugin-security";
import unusedImports from "eslint-plugin-unused-imports";

export default tseslint.config(
  { ignores: ["node_modules/**", ".claude/worktrees/**", ".zcode/**", "**/dist/**", "scripts/*.py", "docs/diagrams/**"] },
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
  {
    // The whole contracts package holds server code: a value taken from it breaks the page that loads it. The web app takes types from it, and values from its subpaths.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: [{ name: "@brain/contracts", allowTypeImports: true, message: "Take a value from a subpath that runs in a browser, such as @brain/contracts/packs." }] }],
    },
  },
);
