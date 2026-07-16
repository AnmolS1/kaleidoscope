import { useEffect } from "preact/hooks";
import { effect } from "@preact/signals";
import * as S from "../state";
import { Canvas } from "./Canvas";
import { Toolbar } from "./Toolbar";
import { HelpOverlay } from "./HelpOverlay";
import { SaveDialog } from "./SaveDialog";
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
        case "c":
        case "C":
          scene?.clear();
          break;
        case "g":
        case "G":
          S.showGuides.value = !S.showGuides.value;
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
        case "d":
        case "D": {
          const menu = document.getElementById("download-menu") as HTMLDetailsElement | null;
          if (menu) menu.open = !menu.open;
          break;
        }
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
      <SaveDialog />
    </div>
  );
}

export function App() {
  useGlobalKeys();
  useTheme();
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
