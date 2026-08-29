// The layers panel — DESIGN.md §3, frames `IPadLayers`, `LayersStates`,
// `IPadDark`.
//
// The remove-stroke tool is its sibling in `RemoveStroke.tsx`: both are about
// "which layer am I working on", but one is a docked list and the other a
// canvas overlay, so they are separate modules (and T12 splits them the same
// way on iOS). They share `layers.css`.
//
// SIGNALS LIVE HERE, NOT IN `state.ts`. `openPopover` in `Toolbar.tsx` sets the
// precedent: UI-only state belongs to the component that owns it.

import type { JSX } from "preact";
import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import * as S from "../state";
import { paintStrokes } from "../engine/scene";
import { MAX_LAYERS, MAX_LAYER_NAME } from "../../shared/vector";
import { ClearIcon, EyeIcon, EyeOffIcon } from "./Icons";
import "../styles/layers.css";

// ---- shared UI state -------------------------------------------------------

/** Whether the layers panel is docked open. Toggled by the rail button and `L`. */
export const layersOpen = signal<boolean>(false);

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
                      // Focus alone leaves the caret in the old name with
                      // nothing selected, so typing a new one APPENDS to it —
                      // "Layer 1" became "EverestLayer 1". Renaming almost
                      // always means replacing, so the old name starts selected
                      // and the first keystroke overwrites it; an arrow key
                      // still gets you in to edit instead.
                      onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
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
