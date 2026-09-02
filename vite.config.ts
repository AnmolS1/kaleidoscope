import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin wires the SPA client build to the Worker (src/worker/index.ts),
// runs the Worker in workerd during `vite dev`, and points the assets binding at the
// client build output automatically. See https://developers.cloudflare.com/workers/vite-plugin/
export default defineConfig({
  plugins: [preact(), cloudflare()],
  build: {
    // `hidden` emits the map but drops the `//# sourceMappingURL=` comment, so
    // the file is not advertised and browsers do not fetch it.
    //
    // It used to be `true`, which publishes the client's full original source to
    // `/assets/*.js.map` — Workers Assets serves everything under
    // `dist/client`, so the maps were live on the public site. Keeping them
    // built (rather than off) means a stack trace can still be symbolicated
    // from the build output; it just is not handed to every visitor.
    sourcemap: "hidden",
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
