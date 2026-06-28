import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin wires the SPA client build to the Worker (src/worker/index.ts),
// runs the Worker in workerd during `vite dev`, and points the assets binding at the
// client build output automatically. See https://developers.cloudflare.com/workers/vite-plugin/
export default defineConfig({
  plugins: [preact(), cloudflare()],
  build: {
    sourcemap: true,
  },
});
