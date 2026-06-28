import { useEffect, useRef, useState } from "preact/hooks";
import * as S from "../state";
import { exportWebP, exportThumb, exportOG } from "../engine/export";
import { serialize } from "../engine/strokes";
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

  const close = () => (S.saveOpen.value = false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    if (scene.strokeCount === 0) {
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
      S.navigate(`/p/${id}`);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "error";
      setError(
        code === "rate_limited"
          ? "You're saving very fast — try again in a bit."
          : "Couldn't save. Please try again.",
      );
      setBusy(false);
    }
  }

  return (
    <div class="overlay" onClick={close}>
      <div class="overlay-card" role="dialog" aria-modal="true" aria-label="Save to gallery" onClick={(e) => e.stopPropagation()}>
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
