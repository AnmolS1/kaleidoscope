import { defineConfig } from "vitest/config";

// Standalone config so unit tests run in plain Node without the Cloudflare/Vite
// dev plugins. Engine units under test (symmetry, stroke (de)serialization, SVG
// string emission, validation caps) are pure and need no DOM.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/unit/**/*.test.ts", "test/worker/**/*.test.ts"],
  },
});
