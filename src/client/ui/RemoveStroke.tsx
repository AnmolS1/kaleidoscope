// The remove-stroke tool (`E`) — DESIGN.md §3, frame `IPadRemoveStroke`.
//
// A canvas overlay, not a docked panel: it draws the halo over every symmetry
// image of the hit stroke and puts a confirm capsule beside the tap. The layers
// panel is the other half of "which layer am I working on" and lives next door
// in `LayersPanel.tsx`; they are kept apart because one is a list and one is an
// overlay, and iOS (T12) splits them the same way.
//
// 🔴 `removeMode` is deliberately NOT a member of `S.tool`, contrary to the
// insertion-point comment T06b left in `Toolbar.tsx`. `S.tool` is typed
// `BrushTool` from `src/shared/vector.ts`, and `BrushTool` IS `Stroke.tool` —
// the wire format, mirrored in Swift and enforced by `deserialize`. `scene.ts`
// copies `this.state.tool` straight into the stroke it is building, so widening
// that union would stamp `tool: "remove"` onto the next real stroke; the lead
// ran it, and such a drawing is rejected at parse with `layer 0 stroke 0: bad
// tool`, leaving it both unsaveable and unloadable long after the mistake.
// Keeping remove-stroke a separate mode also restores the previous brush for
// free when the tool is dropped.

import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import * as S from "../state";
import { drawingToScreen, type StrokeHit } from "../engine/scene";
import { strokeSegments } from "../engine/brush";
import { forEachImage, imageTransformSvg } from "../engine/symmetry";
import { REFERENCE_HALF, halfAxis } from "../../shared/vector";
import { LayersIcon } from "./Icons";
import { showToast } from "./Toast";
import "../styles/layers.css";

/** Whether the remove-stroke tool (`E`) is armed. See the header note. */
export const removeMode = signal<boolean>(false);

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
