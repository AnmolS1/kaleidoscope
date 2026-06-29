// App state as signals. Tool signals drive the engine via a single effect in
// Canvas.tsx; UI components read/write them directly. Auth + route signals are
// used from Phase 6 onward.

import { signal } from "@preact/signals";
import type { Scene } from "./engine/scene";
import type { Background, BrushTool, Drawing } from "./engine/strokes";
import { type SessionUser, fetchMe } from "./api";

// --- tool state ---
export const tool = signal<BrushTool>("solid");
export const color = signal<string>("#E84A27");
export const size = signal<number>(6);
export const opacity = signal<number>(1);
export const segments = signal<number>(12);
export const mirror = signal<boolean>(true);
export const bg = signal<Background>("light");
export const showGuides = signal<boolean>(true);

// --- engine handle + history flags ---
export const scene = signal<Scene | null>(null);
export const canUndo = signal<boolean>(false);
export const canRedo = signal<boolean>(false);
export const strokeCount = signal<number>(0);

// --- auth ---
export const me = signal<SessionUser | null>(null);
export const authLoaded = signal<boolean>(false);

export async function initAuth(): Promise<void> {
  try {
    me.value = await fetchMe();
  } catch {
    me.value = null;
  } finally {
    authLoaded.value = true;
  }
}

// --- remix: a drawing to load into the studio + the parent id to record ---
export const pendingRemix = signal<Drawing | null>(null);
export const remixOf = signal<string | null>(null);

// --- UI ---
export const helpOpen = signal<boolean>(false);
export const saveOpen = signal<boolean>(false);

// --- responsive ---
// The toolbar renders structurally different DOM per breakpoint (desktop keeps
// the full row; tablet/phone collapse sliders into popovers). This is a
// client-only SPA — no SSR — so matchMedia().matches is truthful on the first
// render and there's no hydration flash.
export type Breakpoint = "desktop" | "tablet" | "phone";

function computeBreakpoint(): Breakpoint {
  if (typeof matchMedia === "undefined") return "desktop";
  if (matchMedia("(min-width: 1024px)").matches) return "desktop";
  if (matchMedia("(min-width: 641px)").matches) return "tablet";
  return "phone";
}

export const breakpoint = signal<Breakpoint>(computeBreakpoint());

// --- routing ---
export const route = signal<string>(typeof location !== "undefined" ? location.pathname : "/");

export function navigate(path: string): void {
  if (path === route.value) return;
  history.pushState({}, "", path);
  route.value = path;
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    route.value = location.pathname;
  });

  // Two width queries cover all three buckets; they also fire on
  // orientationchange because the viewport width changes.
  const onBp = () => {
    breakpoint.value = computeBreakpoint();
  };
  matchMedia("(min-width: 1024px)").addEventListener("change", onBp);
  matchMedia("(min-width: 641px)").addEventListener("change", onBp);
}

export const PALETTE = [
  { name: "Crane", value: "#E84A27" },
  { name: "Saffron", value: "#D9A521" },
  { name: "Teal", value: "#1D9E75" },
  { name: "Orbit", value: "#2A2A6E" },
  { name: "Graphite", value: "#1B2A33" },
];
