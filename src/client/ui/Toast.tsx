import type { JSX } from "preact";
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import * as S from "../state";

/**
 * The studio's one-at-a-time nudge (DESIGN.md §3 "Toasts").
 *
 * A separate module rather than an export from `App.tsx` on purpose: `App`
 * imports `Toolbar`, so a `Toolbar → App` import for `showToast` would be a
 * cycle. It also happens to be what T06c ("Switched to Ribbons", the hidden-layer
 * refusal) and T07 ("Update available") both need, so it is a shared seam, not a
 * private helper.
 *
 * Rules the host enforces, from the spec: one toast at a time, dismissed by the
 * next stroke or after 6 seconds, bottom-left above the rail (regular) or above
 * the dock (phone).
 */
export interface Toast {
  /** Bumped on every show so a repeat of the same message restarts the timer. */
  id: number;
  text: string;
  /** Small mark in crane-strong. Decorative — the text carries the meaning. */
  icon?: JSX.Element;
  /** Optional chip CTA, e.g. "Open Brush". Dismisses the toast when clicked. */
  cta?: { label: string; onClick: () => void };
}

export const toast = signal<Toast | null>(null);

let nextId = 1;

export function showToast(t: Omit<Toast, "id">): void {
  toast.value = { ...t, id: nextId++ };
}

export function dismissToast(): void {
  toast.value = null;
}

export function ToastHost() {
  const t = toast.value;
  // Read the stroke count in the render body so this component re-renders when
  // a stroke commits — that is the spec's other dismissal trigger.
  const strokes = S.strokeCount.value;
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!t) return;
    // A toast is often raised BY the gesture that is about to commit a stroke —
    // `penSeen` latches on the first pen contact, and the stroke lands a moment
    // later. Arming the stroke dismissal after a short grace stops a toast from
    // killing itself with the very stroke that summoned it, which is what a
    // naive "dismiss whenever strokeCount changes" does.
    setArmed(false);
    const arm = setTimeout(() => setArmed(true), 900);
    const expire = setTimeout(dismissToast, 6000);
    return () => {
      clearTimeout(arm);
      clearTimeout(expire);
    };
  }, [t?.id]);

  useEffect(() => {
    if (t && armed) dismissToast();
  }, [strokes]);

  if (!t) return null;

  return (
    <div class="toast-host">
      <div class="toast" role="status" aria-live="polite" key={t.id}>
        {t.icon ? (
          <span class="toast-icon" aria-hidden="true">
            {t.icon}
          </span>
        ) : null}
        <span class="toast-text">{t.text}</span>
        {t.cta ? (
          <button
            class="chip"
            onClick={() => {
              t.cta?.onClick();
              dismissToast();
            }}
          >
            {t.cta.label}
          </button>
        ) : null}
        <button class="toast-close icon-btn" aria-label="Dismiss" onClick={dismissToast}>
          ✕
        </button>
      </div>
    </div>
  );
}
