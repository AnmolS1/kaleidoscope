import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      ".wrangler/**",
      "old/**",
      "node_modules/**",
      "coverage/**",
      ".remember/**",
      "test-results/**",
      "playwright-report/**",
      // Gitignored working dirs. Flat config does NOT auto-ignore these, so
      // scratch scripts in them get linted (and double-report against any
      // worktree copy) unless named here.
      ".claude/**",
      "kaleidoscope-plan/**",
      // Gitignored operator scripts. They are Node programs, so linting them
      // under the browser/worker globals reports `process` and `console` as
      // undefined and turns the gate red for a file that is never shipped.
      "scripts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/client/**/*.{ts,tsx}", "test/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2023 },
    },
  },
  {
    files: ["src/worker/**/*.ts"],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.es2023 },
    },
  },
  {
    files: ["public/sw.js"],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
