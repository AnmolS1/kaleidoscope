// The protractor-style symmetry dial (DESIGN.md §3, frames `Dial` /
// `WebDesktop`). Every number here is measured off `src/Dial.dc.html`; the
// colours are tokens, never the artboard's resolved literals.
//
// The geometry lives in exported pure functions rather than inline in the
// render, because they are the thing worth testing: `angleFor`/`pointFor` place
// the ticks, labels and handle, and `valueForPoint` reads a drag back out. A
// test that only exercised one of the two would pass with a mapping that is
// self-consistently wrong.

import { useRef } from "preact/hooks";
import * as S from "../state";
import { MirrorIcon } from "./Icons";
import "../styles/dial.css";

export const MIN_SEGMENTS = 3;
export const MAX_SEGMENTS = 24;

/**
 * The viewBox is `0 0 220 220` and the dial centre is (110,110) — NOT a
 * centred `-110 -110 220 220` box, which would be the obvious choice.
 *
 * 🔴 Chromium resolves a CSS `transform-origin` length against the raw user
 * coordinates and ignores the viewBox's min-x/min-y, so with a centred box the
 * handle's `transform-origin: 50% 50%` (= `110px 110px`) lands on user
 * (110,110) — the bottom-right CORNER of a centred box — instead of (0,0).
 * The handle then swung a full dial-width away from the ring, silently, with a
 * computed `transform` matrix that was perfectly correct. Anchoring the box at
 * 0,0 makes both readings of `50% 50%` the same point.
 *
 * Geometry is still computed centre-relative (that is the artboard's frame, and
 * what the unit test compares against); `vx`/`vy` shift it for rendering.
 */
const VIEW = 220;
const C = VIEW / 2;
const RING_R = 80;
/**
 * Label centres sit on this radius, baseline nudged +3.5 to optically centre
 * 10px mono.
 *
 * DEVIATION from DESIGN.md §3, which specifies ring + 17px. At 17 the handle
 * OVERLAPS the "24" label by 1.5px — measured, not estimated: 24 sits at the
 * end of the sweep where the label's ray runs diagonally, so the corner of its
 * glyph box reaches inside the handle's 10px painted radius (r=9 plus half of
 * its 2px ring). 21px is the smallest whole-pixel radius that clears every
 * label, and the spec's own rule — "the handle must never cover a label" — is
 * the one being kept. `dial.spec.ts` measures the clearance rather than
 * trusting this number.
 */
const LABEL_R = RING_R + 21;
const LABEL_BASELINE_NUDGE = 3.5;
const MAJOR_INNER_R = 70;
const MINOR_INNER_R = 74;
/** The 30px centre disc that holds the mirror toggle. */
const CENTRE_DISC_R = 15;
/**
 * Presses inside this radius do not drag the ring. Wider than the disc because
 * the mirror toggle is shipped at the 44px touch minimum (radius 22) even
 * though it only *looks* 30px, and a press that misses the button by a pixel
 * must not silently spin the dial instead.
 */
const DEAD_ZONE_R = 24;
const GUIDE_R = 46;
const HANDLE_R = 9;

// 3 sits at −240° and 24 at +60°, measured from +x with y pointing DOWN (SVG's
// own convention), leaving a 60° gap at the bottom of the ring.
const START_DEG = -240;
const SWEEP_DEG = 300;
const DEG = Math.PI / 180;

/** Where on the ring a segment count sits, in degrees. */
export function angleFor(value: number): number {
  return START_DEG + ((value - MIN_SEGMENTS) / (MAX_SEGMENTS - MIN_SEGMENTS)) * SWEEP_DEG;
}

/** That angle as a point at radius `r`, in viewBox units. */
export function pointFor(value: number, r: number): { x: number; y: number } {
  const a = angleFor(value) * DEG;
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
}

/**
 * The inverse: which segment count an angle on the ring means.
 *
 * Angles in the 60° dead gap below the dial snap to whichever end of the sweep
 * is nearer around the ring, so dragging off the bottom parks at 3 or 24 rather
 * than jumping across the dial.
 */
export function valueForAngle(deg: number): number {
  const past = (((deg - START_DEG) % 360) + 360) % 360; // degrees travelled from 3
  if (past > SWEEP_DEG) {
    const gapMid = SWEEP_DEG + (360 - SWEEP_DEG) / 2;
    return past <= gapMid ? MAX_SEGMENTS : MIN_SEGMENTS;
  }
  const t = past / SWEEP_DEG;
  return Math.round(MIN_SEGMENTS + t * (MAX_SEGMENTS - MIN_SEGMENTS));
}

/** `valueForAngle` for a point relative to the dial centre, in viewBox units. */
export function valueForPoint(x: number, y: number): number {
  return valueForAngle(Math.atan2(y, x) / DEG);
}

const TICKS = Array.from({ length: MAX_SEGMENTS - MIN_SEGMENTS + 1 }, (_, i) => MIN_SEGMENTS + i);
const f = (n: number) => Math.round(n * 100) / 100;
/** Centre-relative viewBox units → the 0-anchored box the SVG actually uses. */
const vb = (n: number) => f(n + C);

export function SymmetryDial() {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const value = S.segments.value;
  const mirrored = S.mirror.value;

  const set = (v: number) => {
    const next = Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.round(v)));
    if (S.segments.peek() !== next) S.segments.value = next;
  };

  // Pointer → viewBox units. Scaling by VIEW/rect.width rather than assuming
  // 1:1 keeps the drag honest if the card ever squeezes the dial narrower than
  // 220px (it can, inside the phone sheet).
  const valueAt = (e: PointerEvent): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = (e.clientX - (r.left + r.width / 2)) * (VIEW / r.width);
    const y = (e.clientY - (r.top + r.height / 2)) * (VIEW / r.height);
    // The middle of the dial belongs to the mirror toggle, and an angle read
    // that close to the centre is mostly noise anyway.
    if (Math.hypot(x, y) < DEAD_ZONE_R) return null;
    return valueForPoint(x, y);
  };

  /**
   * Seal the gesture. Clearing the flag alone is not enough — the engine's
   * coalesce key outlives the flag, so the NEXT change would still merge into
   * this drag's undo entry.
   */
  const endGesture = () => {
    S.symDragging.value = false;
    S.scene.peek()?.endSymGesture();
  };

  const onDown = (e: PointerEvent) => {
    const v = valueAt(e);
    if (v === null) return;
    e.preventDefault();
    dragging.current = true;
    // Both state writes happen BEFORE the DOM call, and both orderings are
    // load-bearing.
    //
    // `setPointerCapture` throws `NotFoundError` when there is no live pointer
    // with that id. It sat first here, and the throw skipped BOTH lines below:
    // `dragging.current` had already been set, so the drag kept running with
    // the gesture flag never raised, and every move of the sweep committed its
    // own undo entry. The sweep still looked perfect on screen — only the undo
    // stack knew.
    //
    // The flag also has to precede `set(v)`, because the effect that pushes the
    // value into the engine reads the flag with `.peek()` at the moment of the
    // write: raised afterwards, the first step of the drag would anchor its own
    // entry and the rest would merge behind it, leaving a stray step that a
    // depth-only assertion would happily call correct.
    S.symDragging.value = true;
    set(v);
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // No live pointer to capture. The drag still tracks via the move handler.
    }
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging.current) return;
    const v = valueAt(e);
    if (v !== null) set(v);
  };
  const onUp = (e: PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    // Seal FIRST. `releasePointerCapture` throws `NotFoundError` when the
    // pointer is no longer captured — which the touch suite provokes with
    // synthetic events, and a real pointer can do by leaving the document —
    // and a throw on that line would skip the seal, silently merging the NEXT
    // change into this gesture's undo entry. Ordering the state change ahead
    // of the DOM call is what keeps one failure from becoming two.
    endGesture();
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // Already released, or never captured. Nothing to undo about it.
    }
  };

  const guides = Array.from({ length: value }, (_, k) => (k * 360) / value);

  return (
    <div class="dial">
      {/* The hidden range carries the semantics; the drawing is decoration. */}
      <svg
        ref={svgRef}
        class="dial-svg"
        width={VIEW}
        height={VIEW}
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        aria-hidden="true"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <circle class="dial-ring" cx={C} cy={C} r={RING_R} />

        {TICKS.map((v) => {
          const major = (v - MIN_SEGMENTS) % 3 === 0;
          const inner = pointFor(v, major ? MAJOR_INNER_R : MINOR_INNER_R);
          const outer = pointFor(v, RING_R);
          return (
            <line
              key={`t${v}`}
              class={"dial-tick" + (v <= value ? " is-on" : "") + (major ? " is-major" : "")}
              x1={vb(inner.x)}
              y1={vb(inner.y)}
              x2={vb(outer.x)}
              y2={vb(outer.y)}
            />
          );
        })}

        {TICKS.filter((v) => (v - MIN_SEGMENTS) % 3 === 0).map((v) => {
          const p = pointFor(v, LABEL_R);
          return (
            <text
              key={`l${v}`}
              class="dial-label"
              data-value={v}
              x={vb(p.x)}
              y={vb(p.y + LABEL_BASELINE_NUDGE)}
              text-anchor="middle"
            >
              {v}
            </text>
          );
        })}

        {/* Live preview: one ray per image the current count produces. */}
        <g class="dial-guides">
          {guides.map((deg, i) => (
            <line
              key={`g${i}`}
              class="dial-guide"
              x1={C}
              y1={C}
              x2={C}
              y2={C - GUIDE_R}
              transform={`rotate(${f(deg)} ${C} ${C})`}
            />
          ))}
        </g>

        <circle class="dial-disc" cx={C} cy={C} r={CENTRE_DISC_R} />

        <g class="dial-handle" style={{ transform: `rotate(${f(angleFor(value))}deg)` }}>
          <circle class="dial-knob" cx={C + RING_R} cy={C} r={HANDLE_R} />
        </g>
      </svg>

      <button
        type="button"
        class="dial-mirror"
        aria-label="Mirror (dihedral symmetry)"
        aria-pressed={mirrored}
        onClick={() => (S.mirror.value = !mirrored)}
      >
        <MirrorIcon width="20" height="20" />
      </button>

      {/* iOS VoiceOver adjusts a real range; the arrow keys drive it too. */}
      <input
        class="visually-hidden dial-range"
        type="range"
        min={MIN_SEGMENTS}
        max={MAX_SEGMENTS}
        step={1}
        value={value}
        onInput={(e) => {
          // A HELD arrow key fires `input` repeatedly with no keyup in between,
          // so coalescing on every input and sealing on key-up is what makes a
          // held press one undo entry while three separate presses stay three.
          S.symDragging.value = true;
          set(+(e.target as HTMLInputElement).value);
        }}
        onKeyUp={endGesture}
        onPointerUp={endGesture}
        onBlur={endGesture}
        aria-label="Symmetry segments"
        aria-valuetext={`${value} segments, ${mirrored ? "mirrored" : "rotational"}`}
      />
    </div>
  );
}
