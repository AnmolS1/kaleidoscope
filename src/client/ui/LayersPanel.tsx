// The layers panel and the remove-stroke tool (DESIGN.md §3, frames
// `IPadLayers`, `LayersStates`, `IPadRemoveStroke`, `IPadDark`, `Nudges`).
//
// WHY BOTH LIVE IN ONE MODULE: they are the two halves of "which layer am I
// working on". Remove-stroke switches the active layer as a side effect of a
// tap and announces it with the same toast the panel's own nudges use, and both
// read the layer stack through the same helpers. Splitting them would mean
// exporting those helpers plus the `pendingHit` signal across a file boundary
// for no gain.
//
// SIGNALS LIVE HERE, NOT IN `state.ts`. `openPopover` in `Toolbar.tsx` sets the
// precedent: UI-only state belongs to the component that owns it.
//
// 🔴 `removeMode` is deliberately NOT a member of `S.tool`, contrary to the
// insertion-point comment T06b left in `Toolbar.tsx`. `S.tool` is typed
// `BrushTool` from `src/shared/vector.ts`, and `BrushTool` IS `Stroke.tool` —
// the wire format, mirrored in Swift and enforced by the Worker's `validate.ts`.
// `scene.onDown` copies `this.state.tool` straight into the stroke it is
// building, so widening that union would stamp `tool: "remove"` onto the next
// real stroke, and the damage would stay invisible until someone saved. Keeping
// remove-stroke a separate mode also means leaving it restores the previous
// brush for free.

import type { JSX } from "preact";
import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import * as S from "../state";
import { paintStrokes, drawingToScreen, type StrokeHit } from "../engine/scene";
import { strokeSegments } from "../engine/brush";
import { forEachImage, imageTransformSvg } from "../engine/symmetry";
import { MAX_LAYERS, MAX_LAYER_NAME, REFERENCE_HALF, halfAxis } from "../../shared/vector";
import { ClearIcon, EyeIcon, EyeOffIcon, LayersIcon } from "./Icons";
import { showToast } from "./Toast";
import "../styles/layers.css";

// ---- shared UI state -------------------------------------------------------

/** Whether the layers panel is docked open. Toggled by the rail button and `L`. */
export const layersOpen = signal<boolean>(false);

/** Whether the remove-stroke tool (`E`) is armed. See the header note. */
export const removeMode = signal<boolean>(false);

// ---- icons the set in Icons.tsx does not carry -----------------------------
// T06b pre-seeded LayersIcon / RemoveStrokeIcon / EyeIcon / EyeOffIcon there;
// these four are the panel's own furniture, declared here rather than in
// `Icons.tsx`, which this task does not own. Consolidating them is a follow-up.

type P = JSX.SVGAttributes<SVGSVGElement>;

function Glyph(props: P & { children: JSX.Element | JSX.Element[] }) {
  const { children, ...rest } = props;
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

const GripIcon = (p: P) => (
  <Glyph {...p}>
    <circle cx="9" cy="6" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="9" cy="18" r="1" />
    <circle cx="15" cy="6" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="15" cy="18" r="1" />
  </Glyph>
);
const PlusIcon = (p: P) => (
  <Glyph {...p}>
    <path d="M12 5v14M5 12h14" />
  </Glyph>
);
const LockIcon = (p: P) => (
  <Glyph {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Glyph>
);
const DuplicateIcon = (p: P) => (
  <Glyph {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Glyph>
);

// ---- helpers ---------------------------------------------------------------

/** The `12 · D · 70%` line under a layer's name. */
export function symLine(l: { sym: { segments: number; mirror: boolean }; opacity: number }): string {
  return `${l.sym.segments} · ${l.sym.mirror ? "D" : "C"} · ${Math.round(l.opacity * 100)}%`;
}

/**
 * The hidden-active-layer nudge (DESIGN.md §3, frame `Nudges`).
 *
 * The engine REFUSES a stroke drawn on a hidden active layer and fires
 * `onHiddenLayerRefusal` with that layer's name. The layer is never
 * auto-unhidden — the CTA is the only way it comes back, which is the whole
 * point of refusing rather than silently storing invisible ink.
 *
 * Takes the id as well as the name because layer names are NOT unique: looking
 * the layer back up by name would unhide the wrong one whenever two layers
 * share a name. The refusal is always about the active layer, so that is the
 * default.
 */
export function showHiddenLayerToast(layerName: string, layerId?: string): void {
  const id = layerId ?? S.activeLayerId.peek();
  showToast({
    icon: <EyeOffIcon />,
    text: `“${layerName}” is hidden, so nothing was drawn.`,
    cta: {
      label: "Show layer",
      onClick: () => {
        S.scene.peek()?.setLayerVisible(id, true);
      },
    },
  });
}

// ---- the panel -------------------------------------------------------------

/** A 34px render of one layer alone, in the inset well. */
function LayerThumb({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Redraw when this layer's ink or its symmetry changes. Layer OPACITY is
  // deliberately not a dependency: the thumbnail shows the layer at full
  // strength, the way the frames draw it — the percentage is on the row.
  const layer = S.layers.value.find((l) => l.id === id);
  const dep = `${layer?.strokeCount ?? 0}:${layer?.sym.segments ?? 0}:${layer?.sym.mirror ?? false}`;

  useLayoutEffect(() => {
    const canvas = ref.current;
    const scene = S.scene.peek();
    if (!canvas || !scene) return;
    const dpr = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
    const size = 34;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const src = scene.getDrawing().layers.find((l) => l.id === id);
    if (!src || src.strokes.length === 0) return;
    // A thumbnail is a whole drawing shrunk to 34px, so `half` shrinks with it
    // and every stroke width comes down by the same factor. Inset by 1px so ink
    // that reaches the rim is not clipped flush against the well.
    paintStrokes(ctx, src.strokes, size, size, size / 2 - 1, src.sym);
  }, [id, dep]);

  return <canvas class="layer-thumb" ref={ref} width={34} height={34} aria-hidden="true" />;
}

interface DragState {
  id: string;
  /** Display index (0 = top row) the drag started from. */
  from: number;
  startY: number;
  dy: number;
  rowH: number;
  /** Display index the row would land on if released now. */
  to: number;
}

/** How far row `i` slides to make room for the row being dragged over it. */
function shift(drag: DragState, i: number): number {
  if (i === drag.from) return 0;
  if (drag.to > drag.from && i > drag.from && i <= drag.to) return -1;
  if (drag.to < drag.from && i < drag.from && i >= drag.to) return 1;
  return 0;
}

/**
 * `onOpenSym` is a prop rather than an import of `Toolbar`'s `openPopover`:
 * `Toolbar` imports THIS module for the rail button and the panel mount, so
 * importing back would make the two files a cycle.
 */
export function LayersPanel({ onOpenSym }: { onOpenSym?: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Escape unmounts the rename input, which fires its `blur` on the way out —
  // and blur is what COMMITS. Without this latch, cancelling an edit saves it.
  const renameCancelled = useRef(false);

  const open = layersOpen.value;
  const stack = S.layers.value;
  const activeId = S.activeLayerId.value;
  const cap = S.layerCap.value;
  const scene = S.scene.value;

  // ROW ORDER IS THE REVERSE OF MODEL ORDER. `S.layers` is bottom-first (the
  // renderer paints in that order and `hitTestDrawing` walks it backwards for
  // the topmost hit); the panel lists the TOP layer first, exactly as the frames
  // draw it. Every index that crosses back into the engine has to be flipped —
  // and getting that backwards still looks like "the order changed", which is
  // why the spec pins the bottom row against the readout's `L1`.
  const rows = stack.slice().reverse();
  const toModelIndex = (displayIndex: number) => stack.length - 1 - displayIndex;

  const endDrag = (commit: boolean) => {
    setDrag((d) => {
      if (d && commit && d.to !== d.from) scene?.moveLayer(d.id, toModelIndex(d.to));
      return null;
    });
  };

  // Escape at the window, not on the panel: during a pointer drag the keyboard
  // focus is wherever it was, so a handler bound to the panel's subtree would
  // simply never see it. Order matters — a drag and a rename each own Escape as
  // their own cancel before it reaches "close the panel".
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (drag) {
        endDrag(false);
        return;
      }
      if (editing) return; // the rename input's own handler cancels it
      layersOpen.value = false;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open) return null;

  const atCap = stack.length >= cap;
  const free = cap < MAX_LAYERS;

  const commitRename = (id: string, value: string) => {
    const name = value.trim().slice(0, MAX_LAYER_NAME);
    if (name) scene?.setLayerName(id, name);
    setEditing(null);
  };

  // Pointer events, not HTML5 `draggable`: the drag has to work under a finger
  // on an iPad, where `dragstart` never fires.
  const onGripDown = (e: JSX.TargetedPointerEvent<HTMLElement>, id: string, index: number) => {
    if (!e.isPrimary) return;
    const el = e.currentTarget as HTMLElement;
    const row = el.closest(".layer-row") as HTMLElement | null;
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    setDrag({ id, from: index, startY: e.clientY, dy: 0, rowH: row?.offsetHeight || 46, to: index });
  };

  const onGripMove = (e: JSX.TargetedPointerEvent<HTMLElement>) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    const to = Math.max(0, Math.min(rows.length - 1, drag.from + Math.round(dy / drag.rowH)));
    if (dy !== drag.dy || to !== drag.to) setDrag({ ...drag, dy, to });
  };

  const onGripUp = (e: JSX.TargetedPointerEvent<HTMLElement>) => {
    if (!drag) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    endDrag(true);
  };

  return (
    <>
      {/* Phone only (see layers.css) — the sheet covers its own triggers. */}
      <div class="layers-scrim" onClick={() => (layersOpen.value = false)} />
      <div class="layers-panel" role="region" aria-label="Layers">
        <div class="layers-head">
          <span class="pop-title">Layers</span>
          <span class="mono layers-count">
            {stack.length} of {cap}
          </span>
        </div>

        <div class="layer-list">
          {rows.map((l, i) => {
            const isActive = l.id === activeId;
            const dragging = drag?.id === l.id;
            const slide = drag ? shift(drag, i) * drag.rowH : 0;
            const offset = dragging ? drag.dy : slide;
            return (
              <div
                key={l.id}
                class={
                  "layer-row" +
                  (isActive ? " is-active" : "") +
                  (l.visible ? "" : " is-hidden") +
                  (dragging ? " is-dragging" : "")
                }
                data-layer-id={l.id}
                style={offset ? { transform: `translateY(${offset}px)` } : undefined}
              >
                <span
                  class="layer-grip"
                  role="button"
                  tabIndex={0}
                  aria-label={`Reorder ${l.name}`}
                  onPointerDown={(e) => onGripDown(e, l.id, i)}
                  onPointerMove={onGripMove}
                  onPointerUp={onGripUp}
                  onPointerCancel={() => endDrag(false)}
                >
                  <GripIcon width="16" height="16" />
                </span>

                <span class="layer-well">
                  <LayerThumb id={l.id} />
                </span>

                <div class="layer-mid">
                  {editing === l.id ? (
                    <input
                      class="layer-rename"
                      autoFocus
                      defaultValue={l.name}
                      maxLength={MAX_LAYER_NAME}
                      aria-label={`Rename ${l.name}`}
                      onBlur={(e) => {
                        if (renameCancelled.current) {
                          renameCancelled.current = false;
                          setEditing(null);
                          return;
                        }
                        commitRename(l.id, (e.target as HTMLInputElement).value);
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitRename(l.id, (e.target as HTMLInputElement).value);
                        if (e.key === "Escape") {
                          renameCancelled.current = true;
                          setEditing(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      class="layer-name"
                      aria-label={`Select ${l.name}`}
                      aria-pressed={isActive}
                      onClick={() => scene?.setActiveLayer(l.id)}
                      onDblClick={() => setEditing(l.id)}
                    >
                      {l.name}
                    </button>
                  )}

                  {/* The sym line is its own control: tapping it makes this the
                      active layer and opens the symmetry popover. Segments and
                      mirror edit the ACTIVE layer by construction
                      (`scene.setSegments` writes `this.doc.activeLayerId`) and the
                      popover's chip names the active layer, so making it active is
                      what "scoped to that layer" can honestly mean here.
                      Active-layer selection is view state, not an undo step, so it
                      costs nothing. */}
                  <button
                    class="layer-sym mono"
                    aria-label={`Symmetry for ${l.name}, ${l.sym.segments} segments`}
                    onClick={() => {
                      scene?.setActiveLayer(l.id);
                      onOpenSym?.();
                    }}
                  >
                    {symLine(l)}
                  </button>
                </div>

                <button
                  class="layer-eye icon-btn"
                  aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
                  aria-pressed={!l.visible}
                  onClick={() => scene?.setLayerVisible(l.id, !l.visible)}
                >
                  {l.visible ? <EyeIcon width="18" height="18" /> : <EyeOffIcon width="18" height="18" />}
                </button>
              </div>
            );
          })}
        </div>

        <hr class="hair" />

        <div class="layer-foot">
          <button
            class="chip"
            disabled={atCap}
            aria-label={atCap ? `Add layer, locked at ${cap}` : "Add layer"}
            onClick={() => scene?.addLayer()}
          >
            {atCap ? <LockIcon width="14" height="14" /> : <PlusIcon width="14" height="14" />} Add
          </button>
          <button
            class="chip"
            disabled={atCap}
            aria-label="Duplicate layer"
            onClick={() => scene?.duplicateLayer()}
          >
            <DuplicateIcon width="14" height="14" />
          </button>
          <button
            class="chip"
            disabled={stack.length <= 1}
            aria-label="Delete layer"
            onClick={() => scene?.removeLayer()}
          >
            <ClearIcon width="14" height="14" />
          </button>
        </div>

        {/* The footnote only appears AT the cap, and the free variant carries the
            way out — the cap is a current count, not a lifetime quota. */}
        {atCap ? (
          <p class="layer-note mono">
            {free ? (
              <>
                Layers: {stack.length} of {cap} ·{" "}
                <button class="link-inline" onClick={() => (S.plusOpen.value = true)}>
                  Kaleidoscope Plus
                </button>{" "}
                unlocks {MAX_LAYERS}
              </>
            ) : (
              <>All {cap} layers in use</>
            )}
          </p>
        ) : null}
      </div>
    </>
  );
}

// ---- remove-stroke ---------------------------------------------------------

interface PendingHit extends StrokeHit {
  /** Where the tap landed, in client coordinates — anchors the capsule. */
  clientX: number;
  clientY: number;
  /**
   * The stack's shape when the hit was taken.
   *
   * `StrokeHit.index` is POSITIONAL. An undo, a delete, a reorder or a layer
   * removal between the tap and the Delete makes that index point at a
   * DIFFERENT stroke, and the capsule would then remove the wrong one —
   * silently, because the count still drops by exactly one. So the highlight is
   * thrown away whenever the shape it was taken against changes.
   */
  shape: string;
}

function stackShape(): string {
  return S.layers.value.map((l) => `${l.id}:${l.strokeCount}`).join("|");
}

const pendingHit = signal<PendingHit | null>(null);
const missAt = signal<{ x: number; y: number; id: number } | null>(null);
let missId = 0;

/** Leaving the tool must not leave a highlight armed behind it. */
export function clearRemoveHighlight(): void {
  pendingHit.value = null;
  missAt.value = null;
}

function removeHit(hit: StrokeHit): void {
  S.scene.peek()?.deleteStroke(hit.layerId, hit.index);
  clearRemoveHighlight();
}

/**
 * The remove-stroke highlight, its confirm capsule, and the tap interception.
 *
 * TAP INTERCEPTION IS A CAPTURE-PHASE LISTENER ON `.canvas-host`, not a
 * full-bleed `pointer-events: auto` catcher. A catcher would also swallow
 * `wheel` (zoom) and multi-touch (pinch), both of which the engine binds to the
 * live canvas — a silent regression of `zoom-pan.spec.ts`. Capture on the host
 * runs BEFORE the engine's own target-phase listeners, so `stopPropagation()`
 * blocks exactly the one gesture this tool replaces and nothing else.
 */
export function RemoveStrokeOverlay() {
  const active = removeMode.value;
  const hit = pendingHit.value;
  const miss = missAt.value;
  // Subscribes the component to the layer stack, so a delete or an undo
  // re-runs the staleness check below without waiting for anything else.
  const shape = stackShape();
  const [, tick] = useState(0);

  // Disarming has to drop the highlight with it.
  useEffect(() => {
    if (!active) clearRemoveHighlight();
  }, [active]);

  // Intercept the tap.
  //
  // ATTACHED ONCE AT MOUNT AND GATED INSIDE THE HANDLER, not attached when the
  // mode turns on. Re-attaching per mode looks tidier and loses taps: signals
  // update the DOM synchronously but effects are flushed afterwards, so between
  // "the readout says REMOVE STROKE" and "the listener exists" there is a real
  // window — and a tap in it reaches the engine and DRAWS. It surfaced as an
  // e2e suite where a different handful of remove-stroke tests failed each run.
  // The handler reads every signal through `.peek()`, so an empty dependency
  // list cannot make it stale.
  useEffect(() => {
    const host = document.querySelector(".canvas-host");
    if (!host) return;

    const onDown = (ev: Event) => {
      const e = ev as PointerEvent;
      if (!removeMode.peek()) return; // the brush owns the canvas
      if (!e.isPrimary) return; // a second finger is a pinch — let it through
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();

      const scene = S.scene.peek();
      if (!scene) return;
      const n = scene.screenToNormalized(e.clientX, e.clientY);
      const found = scene.hitTestStroke(n.x, n.y);
      const current = pendingHit.peek();

      if (!found) {
        // Empty space clears an armed highlight; with nothing armed it earns
        // the "Nothing here" capsule instead.
        if (current) clearRemoveHighlight();
        else {
          missId += 1;
          missAt.value = { x: e.clientX, y: e.clientY, id: missId };
        }
        return;
      }

      if (current && current.layerId === found.layerId && current.index === found.index) {
        removeHit(current);
        return;
      }

      // Switching to the stroke's layer is the point of the tool: whatever you
      // do next is almost always on that layer.
      if (S.activeLayerId.peek() !== found.layerId) {
        const name = S.layers.peek().find((l) => l.id === found.layerId)?.name;
        scene.setActiveLayer(found.layerId);
        if (name) showToast({ icon: <LayersIcon />, text: `Switched to ${name}` });
      }
      missAt.value = null;
      pendingHit.value = { ...found, clientX: e.clientX, clientY: e.clientY, shape: stackShape() };
    };

    host.addEventListener("pointerdown", onDown, true);
    return () => host.removeEventListener("pointerdown", onDown, true);
  }, []);

  // Escape cancels the highlight first, then the tool.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pendingHit.peek()) clearRemoveHighlight();
      else removeMode.value = false;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // The "Nothing here" capsule is brief.
  useEffect(() => {
    if (!miss) return;
    const t = setTimeout(() => {
      if (missAt.peek()?.id === miss.id) missAt.value = null;
    }, 1400);
    return () => clearTimeout(t);
  }, [miss?.id]);

  // Follow the view while a highlight is up. A PAN changes `tx`/`ty` without
  // touching `S.viewScale`, so there is no signal to subscribe to — this frame
  // loop is what keeps the halo on the ink. It runs only while a stroke is
  // highlighted.
  useEffect(() => {
    if (!hit) return;
    let raf = 0;
    let last = "";
    const step = () => {
      const v = S.scene.peek()?.getView();
      // The host's SIZE is in the key as well as the view: a window resize moves
      // the geometry through `getBoundingClientRect` without touching scale or
      // pan, so a view-only key leaves the halo stranded off the ink.
      const host = document.querySelector(".canvas-host") as HTMLElement | null;
      const key = v ? `${v.scale}/${v.tx}/${v.ty}/${host?.clientWidth}x${host?.clientHeight}` : "";
      if (key !== last) {
        last = key;
        tick((n) => n + 1);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [hit?.layerId, hit?.index]);

  if (!active) return null;

  // Invalidate a highlight whose stroke index can no longer be trusted.
  if (hit && hit.shape !== shape) {
    queueMicrotask(clearRemoveHighlight);
    return null;
  }

  const geom = hit ? highlightGeometry(hit) : null;

  return (
    <>
      {geom ? (
        <svg class="remove-highlight" aria-hidden="true">
          {geom.images.map((t, i) => (
            <g key={i} transform={t}>
              <path class="remove-halo" d={geom.d} stroke-width={geom.halo} />
              <path
                class="remove-outline"
                d={geom.d}
                stroke-width={geom.outline}
                stroke-dasharray={geom.dash}
              />
            </g>
          ))}
        </svg>
      ) : null}

      {hit && geom ? (
        <div
          class="remove-capsule"
          role="dialog"
          aria-label="Remove stroke"
          style={{ left: `${geom.capsuleX}px`, top: `${geom.capsuleY}px` }}
        >
          <span class="remove-capsule-text">
            Stroke on <b>{geom.layerName}</b> · {geom.imageCount} images
          </span>
          <button class="btn btn-primary" onClick={() => removeHit(hit)}>
            Delete
          </button>
          <button class="btn btn-ghost" onClick={clearRemoveHighlight}>
            Cancel
          </button>
        </div>
      ) : null}

      {miss ? (
        <div
          class="remove-miss mono-lg"
          role="status"
          style={{ left: `${miss.x}px`, top: `${miss.y}px` }}
        >
          Nothing here
        </div>
      ) : null}
    </>
  );
}

interface HighlightGeometry {
  /** The stroke's path in NORMALIZED base coordinates. */
  d: string;
  /** One SVG transform per symmetry image. */
  images: string[];
  halo: number;
  outline: number;
  dash: string;
  imageCount: number;
  layerName: string;
  capsuleX: number;
  capsuleY: number;
}

/** Screen-space glow around the ink, per side, in CSS px. */
const HALO_PX = 5;
const OUTLINE_PX = 1.5;

function highlightGeometry(hit: PendingHit): HighlightGeometry | null {
  const scene = S.scene.peek();
  const hostEl = document.querySelector(".canvas-host") as HTMLElement | null;
  if (!scene || !hostEl) return null;
  const layer = scene.getDrawing().layers.find((l) => l.id === hit.layerId);
  const stroke = layer?.strokes[hit.index];
  if (!layer || !stroke) return null;

  const rect = hostEl.getBoundingClientRect();
  const half = halfAxis(rect.width, rect.height);
  const view = scene.getView();

  // A group transform that carries normalized base coordinates all the way to
  // client pixels: translate to the (viewed) centre, scale by view × half, then
  // apply the image's own rotation and reflection. `k` is what one normalized
  // unit is worth on screen, which is also what every px width divides by.
  const k = view.scale * half;
  const origin = drawingToScreen(view, rect.width / 2, rect.height / 2);
  const tx = origin.x + rect.left;
  const ty = origin.y + rect.top;

  // `imageTransformSvg` rather than a hand-rolled rotate/scale string: it is the
  // SAME builder the SVG exporter uses, and `symmetry.test.ts` already pins both
  // the rotation direction and the reflect-then-rotate composition on it.
  // Rebuilding the string here would duplicate a convention that no assertion of
  // this task's could re-check — a negated rotation, or a reflection composed
  // the other way round, maps a symmetry group's image set onto ITSELF, so no
  // amount of position-based testing can see either mistake.
  const images: string[] = [];
  forEachImage(layer.sym.segments, layer.sym.mirror, (image) => {
    images.push(`translate(${r(tx)},${r(ty)}) scale(${r(k)}) ${imageTransformSvg(image)}`);
  });

  // BUILT THROUGH `strokeSegments` — the same path builder the canvas and the
  // SVG exporter use. Walking `stroke.pts` directly would outline the raw
  // polyline, which is exactly the bug just fixed in hit-testing: on a tight
  // curl the drawn Bézier bows away from its chord, so a polyline halo visibly
  // misses the ink it claims to be sitting on.
  const pts = stroke.pts;
  if (pts.length === 0) return null;
  let d = `M ${r(pts[0][0])} ${r(pts[0][1])}`;
  // A single-point stroke is a dot: a zero-length path still paints under a
  // round cap.
  if (pts.length === 1) d += ` L ${r(pts[0][0])} ${r(pts[0][1])}`;
  for (const seg of strokeSegments(stroke)) {
    if (seg.c1x === undefined) {
      d += ` L ${r(seg.x)} ${r(seg.y)}`;
    } else {
      d += ` C ${r(seg.c1x)} ${r(seg.c1y!)}, ${r(seg.c2x!)} ${r(seg.c2y!)}, ${r(seg.x)} ${r(seg.y)}`;
    }
  }

  const inkWidth = stroke.size / REFERENCE_HALF;

  // Anchor the capsule beside the tap, biased up and to the right, and keep it
  // on screen — a hit near an edge must not push it out of the viewport.
  const capsuleX = Math.max(12, Math.min(hit.clientX + 16, window.innerWidth - 320));
  const capsuleY = Math.max(12, Math.min(hit.clientY - 44, window.innerHeight - 80));

  return {
    d,
    images,
    halo: inkWidth + (HALO_PX * 2) / k,
    outline: OUTLINE_PX / k,
    dash: `${r(5 / k)} ${r(4 / k)}`,
    imageCount: images.length,
    layerName: layer.name,
    capsuleX,
    capsuleY,
  };
}

function r(n: number): number {
  return Math.round(n * 1000) / 1000;
}
