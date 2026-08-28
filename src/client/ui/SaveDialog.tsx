import { useEffect, useRef, useState } from "preact/hooks";
import * as S from "../state";
import { exportWebP, exportThumb, exportOG } from "../engine/export";
import { serialize } from "../../shared/vector";
import { saveArtwork, loginUrl, getTurnstileSiteKey, ApiError } from "../api";
import { renderTurnstile } from "./turnstile";

type Visibility = "public" | "unlisted" | "private";

export function SaveDialog() {
  if (!S.saveOpen.value) return null;
  return <SaveDialogInner />;
}

function SaveDialogInner() {
  const user = S.me.value;
  const [title, setTitle] = useState("Untitled");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tsRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const close = () => (S.saveOpen.value = false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus management (patterned on HelpOverlay): move focus into the dialog on
  // open, keep Tab within it, and restore focus to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    const focusables = () =>
      Array.from(
        card?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    // Focus the first control (title input when signed in, sign-in link otherwise);
    // fall back to the card itself so focus never sits behind the backdrop.
    (focusables()[0] ?? card)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    card?.addEventListener("keydown", onKey);
    return () => {
      card?.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);

  // render Turnstile when signed in
  useEffect(() => {
    if (!user || !tsRef.current) return;
    const siteKey = getTurnstileSiteKey() ?? "1x00000000000000000000AA";
    let widgetId: string | undefined;
    renderTurnstile(tsRef.current, siteKey, (t) => setToken(t), S.bg.value)
      .then((id) => (widgetId = id))
      .catch(() => setError("Couldn't load verification. Check your connection."));
    return () => {
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [user]);

  async function onSave() {
    const scene = S.scene.value;
    if (!scene) return;
    // VISIBLE strokes, not the total: a drawing whose only ink sits on hidden
    // layers renders blank, so guarding on strokeCount would upload a blank
    // image and a thumbnail to match. DESIGN.md gives this its own dialog state
    // (SaveNothingVisible) — T06a builds that; this keeps it from saving
    // meanwhile.
    if (scene.visibleStrokeCount === 0) {
      setError("Draw something first!");
      return;
    }
    if (!token) {
      setError("Please complete the verification.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const drawing = scene.getDrawing();
      const [image, thumb, og] = await Promise.all([
        exportWebP(drawing, 1024),
        exportThumb(drawing, 512),
        exportOG(drawing),
      ]);
      const { id } = await saveArtwork({
        title: title.trim() || "Untitled",
        visibility,
        drawingJson: serialize(drawing),
        image,
        thumb,
        og,
        turnstileToken: token,
        remixOf: S.remixOf.value,
      });
      S.saveOpen.value = false;
      S.remixOf.value = null;
      S.announce("Saved — opening your piece");
      S.navigate(`/p/${id}`);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "error";
      const msg =
        code === "rate_limited"
          ? "You're saving very fast — try again in a bit."
          : "Couldn't save. Please try again.";
      setError(msg);
      S.announce(msg);
      setBusy(false);
    }
  }

  return (
    <div class="overlay" onClick={close}>
      <div
        class="overlay-card"
        role="dialog"
        aria-modal="true"
        aria-label="Save to gallery"
        tabIndex={-1}
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header class="overlay-head">
          <h2>Save to gallery</h2>
          <button class="icon-btn" aria-label="Close" onClick={close}>✕</button>
        </header>

        {!user ? (
          <div class="save-signin">
            <p>Sign in to save your piece, get a shareable link, and let others remix it. Drawing &amp; download stay free without an account.</p>
            <a class="btn btn-primary" href={loginUrl(location.pathname)}>Sign in with Google</a>
          </div>
        ) : (
          <div class="save-form">
            <label class="field">
              <span>Title</span>
              <input
                type="text"
                value={title}
                maxLength={120}
                onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
                placeholder="Untitled"
              />
            </label>
            <label class="field">
              <span>Visibility</span>
              <select value={visibility} onChange={(e) => setVisibility((e.target as HTMLSelectElement).value as Visibility)}>
                <option value="public">Public — shown in the gallery</option>
                <option value="unlisted">Unlisted — only with the link</option>
                <option value="private">Private — only you</option>
              </select>
            </label>
            <div class="ts-widget" ref={tsRef} />
            {error && <p class="form-error">{error}</p>}
            <div class="save-actions">
              <button class="btn" onClick={close} disabled={busy}>Cancel</button>
              <button class="btn btn-primary" onClick={onSave} disabled={busy}>
                {busy ? "Saving…" : "Save piece"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
