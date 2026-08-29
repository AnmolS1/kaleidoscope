import { render } from "preact";
import { App } from "./ui/App";
import { showToast } from "./ui/Toast";
import { DownloadIcon } from "./ui/Icons";
import { applyUpdate, watchForUpdate } from "./swUpdate";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/studio.css";
import "./styles/pages.css";
// Last, deliberately: these are single-property overrides of chrome positions
// declared in studio.css, and equal specificity means the later file wins. See
// the header of safe-area.css.
import "./styles/safe-area.css";

const root = document.getElementById("app");
if (root) {
  root.replaceChildren();
  render(<App />, root);
}

// Register the service worker in production for offline drawing (PWA), and
// offer the reload when a newer one is parked behind this page. Dev is excluded
// on both counts: `vite dev` serves modules the worker's cache-first rule would
// happily freeze, and no service worker runs there at all.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        watchForUpdate(reg, (waiting) => {
          showToast({
            icon: <DownloadIcon />,
            // No auto-reload anywhere in this path: a reload throws away an
            // unsaved drawing, so taking the update is always the user's move.
            text: "Update available — reload when you're ready.",
            cta: { label: "Reload", onClick: () => applyUpdate(waiting) },
          });
        });
      })
      .catch(() => {});
  });
}
