import { useEffect } from "preact/hooks";
import { effect } from "@preact/signals";
import * as S from "../state";
import { Canvas } from "./Canvas";
import { Toolbar, openPopover } from "./Toolbar";
import { HelpOverlay } from "./HelpOverlay";
import { SaveDialog } from "./SaveDialog";
import { ToastHost, showToast } from "./Toast";
import { PenIcon } from "./Icons";
import { Gallery } from "./Gallery";
import { ArtworkPage } from "./ArtworkPage";

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const scene = S.scene.value;

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) scene?.redo();
        else scene?.undo();
        return;
      }
      if (mod) return; // leave other mod-combos to the browser

      switch (e.key) {
        case "b":
        case "B":
          S.tool.value = "solid";
          break;
        case "g":
        case "G":
          // DESIGN.md's shortcut strip claims G for the glow BRUSH. Guides moved
          // to A ("axes") rather than losing their key; HelpOverlay's SHORTCUTS
          // table is the single place both are written down.
          S.tool.value = "glow";
          break;
        // T06c INSERTION POINT — `case "e"` selects the remove-stroke tool and
        // `case "l"` toggles the layers panel. Flip their `available` flags in
        // HelpOverlay's SHORTCUTS so the strip and the overlay pick them up.
        case "a":
        case "A":
          S.showGuides.value = !S.showGuides.value;
          break;
        case "c":
        case "C":
          scene?.clear();
          break;
        case "m":
        case "M":
          S.mirror.value = !S.mirror.value;
          break;
        case "[":
          S.size.value = Math.max(1, S.size.value - 1);
          break;
        case "]":
          S.size.value = Math.min(40, S.size.value + 1);
          break;
        case ",":
          S.segments.value = Math.max(3, S.segments.value - 1);
          break;
        case ".":
          S.segments.value = Math.min(24, S.segments.value + 1);
          break;
        case "?":
          S.helpOpen.value = true;
          break;
        case "Escape":
          openPopover.value = null;
          break;
        case "d":
        case "D":
          // The toolbar owns which popover is open now, so this can no longer
          // poke `details.open` directly — a controlled <details> would snap
          // shut on the next render.
          openPopover.value = openPopover.peek() === "download" ? null : "download";
          break;
        case "s":
        case "S":
          e.preventDefault();
          S.saveOpen.value = true;
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function useCanvasAnnouncer() {
  // Turn engine stroke-count changes into polite screen-reader announcements.
  // We derive the event from the delta: +1 (or more) is a new/redone stroke,
  // exactly −1 is an undo, and a larger drop to zero is a clear.
  useEffect(() => {
    let prev = S.strokeCount.peek();
    return effect(() => {
      const count = S.strokeCount.value;
      const delta = count - prev;
      prev = count;
      if (delta === 0) return;
      if (delta > 0) S.announceCanvas("Stroke added");
      else if (delta === -1) S.announceCanvas("Stroke undone");
      else S.announceCanvas("Canvas cleared");
    });
  }, []);
}

function usePenToast() {
  // DESIGN.md §3: "Apple Pencil detected — tune pressure in Brush." Fires on the
  // false→true transition only, so a device where the latch is already set from
  // a previous session is not nagged on every load. `penSeen` never goes back to
  // false, so this can raise the toast at most once per session.
  useEffect(() => {
    let prev = S.penSeen.peek();
    return effect(() => {
      const seen = S.penSeen.value;
      if (seen && !prev) {
        showToast({
          icon: <PenIcon />,
          text: "Apple Pencil detected — tune pressure in Brush.",
          cta: {
            label: "Open Brush",
            onClick: () => {
              openPopover.value = "brush";
            },
          },
        });
      }
      prev = seen;
    });
  }, []);
}

function useTheme() {
  // Initialize canvas/page theme from the OS preference once, then mirror the
  // `bg` signal onto <html data-theme> so design tokens switch with the canvas.
  useEffect(() => {
    if (typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches) {
      S.bg.value = "dark";
    }
    // Sync <html data-theme> to the bg signal synchronously on every change.
    // A signals effect (not useEffect) subscribes to bg.value directly, so it
    // fires even though App never reads bg in its render body.
    return effect(() => {
      document.documentElement.dataset.theme = S.bg.value;
    });
  }, []);
}

function Studio() {
  return (
    <div class="studio">
      <Toolbar />
      <main id="main-content" class="studio-main">
        <h1 class="visually-hidden">Kaleidoscope drawing studio</h1>
        <Canvas />
      </main>
      <ToastHost />
      <SaveDialog />
    </div>
  );
}

export function App() {
  useGlobalKeys();
  useTheme();
  usePenToast();
  useCanvasAnnouncer();
  useEffect(() => {
    void S.initAuth();
  }, []);

  const path = S.route.value;

  let view;
  if (path.startsWith("/p/")) {
    view = <ArtworkPage id={path.slice(3)} key={path} />;
  } else if (path === "/gallery") {
    view = <Gallery mine={false} />;
  } else if (path === "/me") {
    view = <Gallery mine={true} />;
  } else {
    view = <Studio />;
  }

  return (
    <>
      <a class="skip-link" href="#main-content">
        Skip to content
      </a>
      {view}
      <HelpOverlay />
      {/* One shared polite live region for the whole app. */}
      <div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {S.announcement.value}
      </div>
    </>
  );
}
