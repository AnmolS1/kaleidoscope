import { useEffect, useRef } from "preact/hooks";
import * as S from "../state";

/**
 * A keyboard shortcut, described once.
 *
 * The help overlay and the desktop shortcut strip both render from this list —
 * DESIGN.md §2 is explicit that the strip "is `HelpOverlay` content surfaced,
 * not new UI", so there is exactly one place a key is written down and the two
 * surfaces cannot drift apart.
 */
export interface Shortcut {
  /** Rendered as one `<kbd>` each. */
  keys: string[];
  /** What it does. Also the strip's caption, so keep it one or two words. */
  label: string;
  /** Longer wording for the overlay's list, where there is room. */
  long?: string;
  /** Whether the desktop strip carries it. The strip is a curated subset. */
  strip?: boolean;
  /**
   * Whether a handler actually honours the key today.
   *
   * `E` (remove-stroke) and `L` (layers panel) are in DESIGN.md's strip but
   * their tool and panel are **T06c's**, not this task's — there is no
   * `remove` member of `BrushTool` and no layers-panel signal to toggle. An
   * unavailable entry is filtered out of both surfaces rather than shipped as a
   * dead key that the strip advertises: a shortcut strip that lies is worse
   * than a short one. T06c flips these two flags and adds the two `case`s in
   * App.tsx's key handler; nothing else has to move.
   */
  available: boolean;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: ["B"], label: "brush", long: "Solid brush", strip: true, available: true },
  { keys: ["G"], label: "glow", long: "Glow brush", strip: true, available: true },
  { keys: ["E"], label: "remove", long: "Remove-stroke tool", strip: true, available: false },
  { keys: ["L"], label: "layers", long: "Layers panel", strip: true, available: false },
  { keys: [",", "."], label: "segments", long: "Symmetry segments − / +", strip: true, available: true },
  { keys: ["[", "]"], label: "size", long: "Brush size − / +", strip: true, available: true },
  { keys: ["⌘Z"], label: "undo", long: "Undo (⇧ to redo)", strip: true, available: true },
  { keys: ["M"], label: "mirror", long: "Toggle mirror", available: true },
  { keys: ["A"], label: "axes", long: "Toggle guide axes", available: true },
  { keys: ["C"], label: "clear", long: "Clear canvas", available: true },
  { keys: ["D"], label: "download", long: "Download menu", available: true },
  { keys: ["S"], label: "save", long: "Save to gallery", available: true },
  { keys: ["?"], label: "all", long: "This help", strip: true, available: true },
];

/** What the desktop strip shows: the curated subset that actually works. */
export const stripShortcuts = (): Shortcut[] => SHORTCUTS.filter((s) => s.strip && s.available);

export function HelpOverlay() {
  const ref = useRef<HTMLDivElement>(null);
  if (!S.helpOpen.value) return null;

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") S.helpOpen.value = false;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const live = SHORTCUTS.filter((s) => s.available);

  return (
    <div class="overlay" onClick={() => (S.helpOpen.value = false)}>
      <div
        class="overlay-card"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <header class="overlay-head">
          <h2>Keyboard shortcuts</h2>
          <button class="icon-btn" aria-label="Close" onClick={() => (S.helpOpen.value = false)}>
            ✕
          </button>
        </header>
        <dl class="shortcuts">
          <div class="shortcut">
            <dt>Draw</dt>
            <dd>Mouse / touch / stylus</dd>
          </div>
          {live.map((s) => (
            <div class="shortcut" key={s.keys.join("")}>
              <dt>
                {s.keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </dt>
              <dd>{s.long ?? s.label}</dd>
            </div>
          ))}
        </dl>
        <p class="overlay-foot">
          Scribble and the canvas mirrors your strokes into a mandala. Download as PNG, SVG, or an
          animated replay — free, no account needed.
        </p>
        <p class="overlay-foot">
          <strong>Accessibility note:</strong> freehand drawing needs a pointer — mouse, touch, or
          stylus — and isn&rsquo;t available from the keyboard yet. Everything else has a keyboard
          shortcut, listed above; the same list is printed along the bottom of the studio on a wide
          screen.
        </p>
      </div>
    </div>
  );
}
