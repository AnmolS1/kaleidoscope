import { useEffect, useRef } from "preact/hooks";
import * as S from "../state";

const SHORTCUTS: [string, string][] = [
  ["Draw", "Mouse / touch / stylus"],
  ["⌘/Ctrl + Z", "Undo"],
  ["⇧ ⌘/Ctrl + Z", "Redo"],
  ["C", "Clear canvas"],
  ["D", "Download menu"],
  ["S", "Save to gallery"],
  ["G", "Toggle guide axes"],
  ["M", "Toggle mirror"],
  ["[  /  ]", "Brush size − / +"],
  [",  /  .", "Segments − / +"],
  ["?", "This help"],
];

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
          {SHORTCUTS.map(([k, v]) => (
            <div class="shortcut" key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p class="overlay-foot">
          Scribble and the canvas mirrors your strokes into a mandala. Download as PNG, SVG, or an
          animated replay — free, no account needed.
        </p>
      </div>
    </div>
  );
}
