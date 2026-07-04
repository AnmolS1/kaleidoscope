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
  server: {
    // Bind all interfaces (incl. the Tailscale one) so a phone on the tailnet can
    // reach the dev server — equivalent to `vite --host`.
    host: true,
    // Vite 5+ 403s any request whose Host header isn't allow-listed ("Blocked
    // request. This host is not allowed."). Reaching the server over Tailscale
    // MagicDNS sends a `*.ts.net` Host, so allow the whole tailnet suffix. (Raw
    // Tailscale IPs, e.g. 100.x.y.z, are permitted without this — IP hosts skip
    // the check.)
    allowedHosts: [".ts.net"],
  },
});
