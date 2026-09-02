// App state as signals. Tool signals drive the engine via a single effect in
// Canvas.tsx; UI components read/write them directly. Auth + route signals are
// used from Phase 6 onward.

import { signal } from "@preact/signals";
import type { Scene } from "./engine/scene";
import type { LayerSummary } from "./engine/history";
import type {
  Background,
  BrushTool,
  DrawingV2,
  PressurePreset,
} from "../shared/vector";
import { DEFAULT_LAYER_CAP, type PlusInfo, type SessionUser, fetchMe } from "./api";

// --- tool state ---
export const tool = signal<BrushTool>("solid");
export const color = signal<string>("#E84A27");
export const size = signal<number>(6);
export const opacity = signal<number>(1);
// segments/mirror are a VIEW onto the active layer, not a global. Canvas.tsx
// pushes writes into the engine (which applies them to the active layer) and
// writes the active layer's values back here whenever the active layer changes.
export const segments = signal<number>(8);
export const mirror = signal<boolean>(true);
/**
 * Whether the symmetry dial is mid-gesture. Read with `.peek()` — it is a
 * channel, not a dependency: the effect that pushes `segments` into the engine
 * must NOT re-run because the flag moved, only because the value did.
 *
 * It exists because the dial and the engine are decoupled by that effect, so
 * "this change is part of one motion" has no other way across the seam.
 */
export const symDragging = signal<boolean>(false);
export const bg = signal<Background>("light");
export const showGuides = signal<boolean>(true);

// --- input preferences (persisted; consumed by the capture path in T04) ---
export const pressurePreset = signal<PressurePreset>(loadStored("kal.pressurePreset", "normal", isPreset));
export const pressureOpacity = signal<boolean>(loadStored("kal.pressureOpacity", false, isBool));
/** Whether a bare finger draws. Off means fingers only pan/zoom. */
export const drawWithFinger = signal<boolean>(loadStored("kal.drawWithFinger", true, isBool));
/**
 * Whether NEW strokes are smoothed. Default on.
 *
 * Per-stroke, not per-document: turning it off makes subsequent strokes omit
 * `sm` and render as polylines, exactly as every v1 stroke already does, so the
 * two kinds coexist in one drawing and nothing about the format changes. It
 * cannot retroactively alter a stroke already committed — which is the point,
 * since the stored PNG of any saved piece has to keep matching it.
 */
export const smoothStrokes = signal<boolean>(loadStored("kal.smoothStrokes", true, isBool));

/**
 * Whether a pen has ever been used on this device.
 *
 * The brush popover keeps its pressure controls hidden until this is true: a
 * preset that shapes nothing (a mouse reports no usable pressure, and the gamma
 * is pen-only) is a control that lies about what it does. Persisted, because
 * "this person has a Pencil" does not stop being true on reload — and it latches
 * on, never off, so putting the Pencil down does not hide settings mid-session.
 */
export const penSeen = signal<boolean>(loadStored("kal.penSeen", false, isBool));

/** Pen hover position in normalized canvas coords, or null. */
export const hoverPoint = signal<{ x: number; y: number } | null>(null);

// --- layers ---
export const layers = signal<LayerSummary[]>([]);
export const activeLayerId = signal<string>("l1");
/** How many layers this account may ADD. Never limits opening or editing. */
export const layerCap = signal<number>(DEFAULT_LAYER_CAP);

// --- view (zoom/pan) ---
// Mirrors of the engine's view, pushed here by Canvas.tsx. T06b's zoom badge
// reads both: `viewScale` for the number, `viewIsDefault` to hide itself.
// (T05 deviation: state.ts belongs to T03, but every other engine mirror —
// layers, canUndo, strokeCount — lives here, and T03 set the same precedent by
// adding T04's pressure signals. Two bare declarations, no logic.)
export const viewScale = signal<number>(1);
export const viewIsDefault = signal<boolean>(true);

// --- engine handle + history flags ---
export const scene = signal<Scene | null>(null);
export const canUndo = signal<boolean>(false);
export const canRedo = signal<boolean>(false);
export const strokeCount = signal<number>(0);
/**
 * Strokes on VISIBLE layers. Use this for "is there anything to save or
 * export" — `strokeCount` includes hidden layers, so a drawing whose only ink
 * is hidden would otherwise pass a not-empty guard and save as a blank image.
 */
export const visibleStrokeCount = signal<number>(0);

// --- auth + entitlement ---
export const me = signal<SessionUser | null>(null);
export const authLoaded = signal<boolean>(false);
export const plus = signal<PlusInfo | null>(null);
/** Drives the Plus sheet (rendered by T08); set from anywhere that hits a gate. */
export const plusOpen = signal<boolean>(false);

export async function initAuth(): Promise<void> {
  try {
    const { user, plus: p } = await fetchMe();
    me.value = user;
    plus.value = p;
    // A worker that predates the entitlement block leaves the free cap in place
    // rather than an undefined one.
    layerCap.value = p ? p.layerCap : DEFAULT_LAYER_CAP;
  } catch {
    me.value = null;
    plus.value = null;
    layerCap.value = DEFAULT_LAYER_CAP;
  } finally {
    authLoaded.value = true;
  }
}

// --- remix: a drawing to load into the studio + the parent id to record ---
export const pendingRemix = signal<DrawingV2 | null>(null);
export const remixOf = signal<string | null>(null);

/** What the save dialog needs to recognise an unchanged remix (T06a). */
export interface RemixSourceMeta {
  id: string;
  title: string;
  isOwner: boolean;
  likes: number;
}
/** Content hash of the piece being remixed, or null when it couldn't be computed. */
export const remixSourceHash = signal<string | null>(null);
export const remixSourceMeta = signal<RemixSourceMeta | null>(null);

// --- UI ---
export const helpOpen = signal<boolean>(false);
export const saveOpen = signal<boolean>(false);

// --- live-region announcements (screen readers) ---
// A single polite aria-live region in App reads this signal. Callers push a
// message via announce(); we clear-then-set on a microtask so repeating the same
// message (e.g. two "Stroke added" in a row) is still spoken.
export const announcement = signal<string>("");

let announceTimer: ReturnType<typeof setTimeout> | undefined;
export function announce(msg: string): void {
  announcement.value = "";
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    announcement.value = msg;
  }, 60);
}

// Canvas events (stroke/undo/clear) can fire in quick succession while drawing,
// so throttle them to avoid flooding the live region during rapid strokes.
let lastCanvasAnnounce = 0;
export function announceCanvas(msg: string): void {
  const now = Date.now();
  if (now - lastCanvasAnnounce < 700) return;
  lastCanvasAnnounce = now;
  announce(msg);
}

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

/**
 * Is this path the studio?
 *
 * The studio is the FALLBACK route — every other path renders something else —
 * so it is defined by exclusion, and both the router and the keyboard handler
 * read it from here rather than restating the list. They diverged once already:
 * the shortcut switch ran app-wide, so `s` on someone else's piece opened the
 * save dialog for the drawing on your own canvas.
 */
export function isStudioRoute(path: string): boolean {
  return !(path.startsWith("/p/") || path === "/gallery" || path === "/me");
}

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

// --- persistence -----------------------------------------------------------
//
// Preferences only, and each read is guarded: localStorage throws outright in
// some privacy modes, so a bad value or a hostile storage must never stop the
// studio from mounting.

function isPreset(v: unknown): v is PressurePreset {
  return v === "light" || v === "normal" || v === "firm";
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function loadStored<T>(key: string, fallback: T, ok: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return ok(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full — a preference is not worth failing over */
  }
}

if (typeof window !== "undefined") {
  pressurePreset.subscribe((v) => persist("kal.pressurePreset", v));
  pressureOpacity.subscribe((v) => persist("kal.pressureOpacity", v));
  drawWithFinger.subscribe((v) => persist("kal.drawWithFinger", v));
  smoothStrokes.subscribe((v) => persist("kal.smoothStrokes", v));
  penSeen.subscribe((v) => persist("kal.penSeen", v));
}

export const PALETTE = [
  { name: "Crane", value: "#E84A27" },
  { name: "Saffron", value: "#D9A521" },
  { name: "Teal", value: "#1D9E75" },
  { name: "Orbit", value: "#2A2A6E" },
  { name: "Graphite", value: "#1B2A33" },
];
