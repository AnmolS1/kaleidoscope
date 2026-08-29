import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import * as S from "../state";
import { exportWebP, exportThumb, exportOG } from "../engine/export";
import { contentHash, paletteOf, serialize, topSym } from "../../shared/vector";
import {
  ApiError,
  getArtwork,
  getTurnstileSiteKey,
  hashLookup,
  loginUrl,
  patchArtwork,
  saveArtwork,
  suggestNames,
  type ArtworkMeta,
  type HashLookup,
} from "../api";
import { renderTurnstile } from "./turnstile";
import { EyeOffIcon, GalleryIcon, LayersIcon } from "./Icons";
import {
  primaryLabel,
  resolveSaveState,
  saveBlocked,
  titleIsInvalid,
  type PostOutcome,
  type SaveStateKind,
} from "./saveState";

type Visibility = "public" | "unlisted" | "private";

/**
 * Title suggestions, cached per content hash for the life of the page.
 *
 * The endpoint runs two model calls, so re-opening the dialog on an unchanged
 * drawing must not pay for them again. Keyed on the hash rather than on the
 * dialog's lifetime because that is what actually determines whether the answer
 * is still about this picture.
 */
const nameCache = new Map<string, string[]>();

/** Kinds that render the title/visibility form rather than taking the card over. */
const FORM_KINDS: SaveStateKind[] = ["first", "title-error", "at-cap", "self-changed", "error"];

export function SaveDialog() {
  if (!S.saveOpen.value) return null;
  return <SaveDialogInner />;
}

function SaveDialogInner() {
  const user = S.me.value;
  const plus = S.plus.value;
  const remix = S.remixSourceMeta.value;
  const remixHash = S.remixSourceHash.value;

  // Seeded with the source title when this is a remix of the user's own piece:
  // "Save as new" wants the old name in the field to edit, not a blank. Any
  // other opening starts empty, with the placeholder carrying the ask — the
  // worker now REFUSES "Untitled" from this client, so pre-filling it would be
  // handing the user a value that cannot be saved.
  const [title, setTitle] = useState(remix?.isOwner ? remix.title : "");
  const [titleTouched, setTitleTouched] = useState(false);
  const [titleRejected, setTitleRejected] = useState(false);
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<"pending" | "failed" | HashLookup>("pending");
  const [post, setPost] = useState<PostOutcome | null>(null);
  const [names, setNames] = useState<string[]>([]);
  /** The piece a "you already have this" / "someone has this" state is about. */
  const [twin, setTwin] = useState<ArtworkMeta | null>(null);
  const [twinAuthor, setTwinAuthor] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [capNote, setCapNote] = useState<{ cap: number; count: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const scene = S.scene.value;
  const visibleStrokes = S.visibleStrokeCount.value;
  const close = () => (S.saveOpen.value = false);

  // The cap the account is already at, from /api/me. `enabled` is the kill
  // switch: while Plus is off there is no cap at all, so a stale count must not
  // be allowed to disable the Public segment.
  // `publicCap` is null whenever the cap is not enforced (Plus held, or the
  // whole feature dark), so it is the only test needed — a count without a cap
  // is not a limit.
  const capActive =
    !!plus && plus.enabled && plus.publicCap !== null && plus.publicCount >= plus.publicCap;
  const capCount = capNote?.count ?? plus?.publicCount ?? 0;
  const capMax = capNote?.cap ?? plus?.publicCap ?? 0;

  const titleInvalid = (titleTouched && titleIsInvalid(title)) || titleRejected;
  // A remix of the user's OWN piece that has since been drawn on. The hash
  // comparison is what makes it "changed": an untouched one comes back from the
  // pre-flight as `mine` instead, which is a different state entirely.
  const remixOfOwnChanged =
    !!remix?.isOwner && !!remixHash && preflight !== "pending" &&
    (preflight === "failed" || preflight.mine === null);

  const kind = resolveSaveState({
    signedIn: !!user,
    visibleStrokes,
    preflight,
    post,
    titleInvalid,
    capReached: capActive,
    remixOfOwnChanged,
  });
  const blocked = saveBlocked(kind, titleInvalid);
  const showForm = FORM_KINDS.includes(kind);
  const savedAtCap = post?.kind === "cap-reached";

  // At the cap, Unlisted is preselected (DESIGN.md §4) — Public is disabled, and
  // leaving the selection on a segment nobody can choose would ship a dialog
  // whose primary button says "Save unlisted" while the control says otherwise.
  // An effect rather than an initial value because /api/me resolves after mount.
  useEffect(() => {
    if (capActive) setVisibility((v) => (v === "public" ? "unlisted" : v));
  }, [capActive]);

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
    // Focus the card itself rather than its first control: the body swaps once
    // the pre-flight lands, so whatever is first RIGHT NOW is usually the close
    // button of a placeholder. The card is a stable target and keeps focus off
    // the page behind the backdrop.
    card?.focus();

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

  // ---- pre-flight: does this exact picture already exist? ----
  //
  // DESIGN.md §4: on open, BEFORE Turnstile renders. The POST's duplicate checks
  // are the safety net; this is what puts "you already saved this" on screen
  // before the user has typed a title they will not get to use.
  useEffect(() => {
    if (!user || !scene || visibleStrokes === 0) return;
    let alive = true;
    void (async () => {
      let sha: string;
      try {
        sha = await contentHash(serialize(scene.getDrawing()));
      } catch {
        // crypto.subtle is absent outside a secure context. No hash means no
        // pre-flight — the save itself still works.
        if (alive) setPreflight("failed");
        return;
      }
      let found: HashLookup;
      try {
        found = await hashLookup(sha);
      } catch {
        // Rate-limited (the route allows 120/h) or offline. A lookup that could
        // not run has learned nothing, so fall through to the ordinary form
        // rather than wedging the dialog shut on a save that would succeed.
        if (alive) setPreflight("failed");
        return;
      }
      if (!alive) return;
      setPreflight(found);
      if (found.mine) {
        getArtwork(found.mine)
          .then((m) => alive && setTwin(m))
          .catch(() => {});
      } else if (found.other) {
        setTwinAuthor(found.other.author);
        getArtwork(found.other.id)
          .then((m) => alive && setTwin(m))
          .catch(() => {});
      } else {
        void suggest(sha);
      }
    })();

    async function suggest(sha: string) {
      const cached = nameCache.get(sha);
      if (cached) {
        if (alive) setNames(cached);
        return;
      }
      if (!scene) return;
      const drawing = scene.getDrawing();
      const sym = topSym(drawing);
      const thumb = await exportThumb(drawing, 512).catch(() => null);
      if (!thumb) return;
      const got = await suggestNames({
        thumb,
        // 0 is the contract's "the visible layers disagree" signal, not 0-fold.
        segments: sym ? sym.segments : 0,
        mirror: !!sym?.mirror,
        palette: paletteOf(drawing),
      });
      nameCache.set(sha, got);
      if (alive) setNames(got);
    }

    return () => {
      alive = false;
    };
  }, []);

  function onTitle(v: string) {
    setTitle(v);
    setTitleTouched(true);
    setTitleRejected(false);
  }

  async function onSave() {
    if (!scene) return;
    // Touch the field on the attempt, so an untouched empty title moves from
    // SaveFirst to SaveTitleError on the click rather than shouting at someone
    // who has not typed yet.
    setTitleTouched(true);
    if (titleIsInvalid(title)) return;
    if (!token) {
      // Deliberately NOT the error state: the Turnstile test/real widget issues
      // its token a beat after the dialog paints, so an early click is a no-op
      // to retry, not a failure to report.
      setHint("Complete the verification to save.");
      return;
    }
    setBusy(true);
    setPost(null);
    setHint(null);
    try {
      const drawing = scene.getDrawing();
      const [image, thumb, og] = await Promise.all([
        exportWebP(drawing, 1024),
        exportThumb(drawing, 512),
        exportOG(drawing),
      ]);
      const res = await saveArtwork({
        title: title.trim(),
        // At the cap the Public segment is disabled and Unlisted is preselected,
        // but a stale count is possible; send what is selected and let the
        // worker's conditional publish be the authority.
        visibility,
        drawingJson: serialize(drawing),
        image,
        thumb,
        og,
        turnstileToken: token,
        remixOf: S.remixOf.value,
      });
      if (res.capReached) {
        // 201: the piece IS saved, as unlisted. Same state, piece in hand.
        setPost({ kind: "cap-reached", id: res.id, cap: res.cap ?? 0, count: res.count ?? 0 });
        setBusy(false);
        S.announce("Saved unlisted — your public wall is full");
        return;
      }
      S.saveOpen.value = false;
      S.remixOf.value = null;
      S.announce("Saved — opening your piece");
      S.navigate(`/p/${res.id}`);
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.status === 409 && e.code === "duplicate_of_other") {
        const of = typeof e.data.of === "string" ? e.data.of : null;
        if (of) {
          setPost({ kind: "duplicate-other", of });
          getArtwork(of)
            .then((m) => {
              setTwin(m);
              setTwinAuthor(m.author.name);
            })
            .catch(() => {});
        } else {
          // No `of` means the twin is someone else's PRIVATE piece. There is
          // nothing to name and nothing to link to, and asking the API again
          // would not change that — it is withheld on purpose.
          setPost({ kind: "duplicate-other-private" });
        }
        return;
      }
      if (e instanceof ApiError && e.status === 400 && e.code === "title_required") {
        // The client check and the worker's disagreed. Trust the worker.
        setTitleRejected(true);
        return;
      }
      setPost({ kind: "error" });
      setHint(
        e instanceof ApiError && e.code === "rate_limited"
          ? "You're saving very fast — try again in a moment."
          : null,
      );
      S.announce("Couldn't reach the gallery");
    }
  }

  /** "Edit title & visibility" on an unchanged piece the user already owns. */
  async function onPatch() {
    if (!twin) return;
    // Send `title` ONLY when it changed. The Worker validates the title only if
    // the body carries one, precisely so a visibility-only edit on one of the
    // old "Untitled" rows keeps working — and always sending it defeats that:
    // the form seeds from the stored title, so a legacy piece named "Untitled"
    // opens already invalid, Save is disabled, and its visibility can never be
    // changed from here. Not reachable while legacy rows have a null
    // content_hash, but the T02c backfill makes it live.
    const trimmed = title.trim();
    const titleChanged = trimmed !== twin.title;
    if (titleChanged) {
      setTitleTouched(true);
      if (titleIsInvalid(title)) return;
    }
    setBusy(true);
    try {
      await patchArtwork(twin.id, titleChanged ? { title: trimmed, visibility } : { visibility });
      S.saveOpen.value = false;
      S.navigate(`/p/${twin.id}`);
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.status === 402 && e.code === "cap_reached") {
        setCapNote({
          cap: typeof e.data.cap === "number" ? e.data.cap : 0,
          count: typeof e.data.count === "number" ? e.data.count : 0,
        });
        setVisibility("unlisted");
        return;
      }
      if (e instanceof ApiError && e.status === 400 && e.code === "title_required") {
        setTitleRejected(true);
        return;
      }
      setPost({ kind: "error" });
    }
  }

  // ---- pieces of the form, shared by every form kind ----

  // Explicit for/id rather than a wrapping <label>: the error message lives in
  // this block, and inside a <label> it would be concatenated into the input's
  // accessible name ("Title Give your piece a real name…"), quietly breaking
  // every getByLabel("Title") in the suite.
  const titleField = (
    <div class="field">
      <label for="save-title">Title</label>
      <input
        id="save-title"
        type="text"
        class={titleInvalid ? "is-invalid" : undefined}
        value={title}
        maxLength={120}
        aria-invalid={titleInvalid}
        aria-describedby={titleInvalid ? "save-title-error" : undefined}
        onInput={(e) => onTitle((e.target as HTMLInputElement).value)}
        placeholder="Give it a name"
      />
      {titleInvalid && (
        <span class="field-error" id="save-title-error">
          Give your piece a real name — “Untitled” doesn’t count.
        </span>
      )}
    </div>
  );

  const nameChips = names.length > 0 && (
    <div class="save-suggest">
      <span class="mono" aria-hidden="true">
        <SparkIcon />
      </span>
      {names.map((n) => (
        <button key={n} type="button" class="chip" onClick={() => onTitle(n)}>
          {n}
        </button>
      ))}
    </div>
  );

  const visibilityField = (
    <div class="field">
      <span id="save-vis-label" class="field-label">Visibility</span>
      <div class="segmented" role="group" aria-labelledby="save-vis-label">
        {(["public", "unlisted", "private"] as const).map((v) => (
          <button
            key={v}
            type="button"
            class={"seg" + (visibility === v ? " is-on" : "")}
            aria-pressed={visibility === v}
            disabled={v === "public" && (capActive || !!capNote)}
            onClick={() => setVisibility(v)}
          >
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>
      {capActive || capNote ? (
        <span class="field-cap">
          Your public wall is full ({capCount} of {capMax}). Post this unlisted now — then make an
          older piece private to free a slot, or{" "}
          <button type="button" class="link-inline" onClick={() => (S.plusOpen.value = true)}>
            get Kaleidoscope Plus
          </button>{" "}
          for unlimited.
        </span>
      ) : (
        plus?.enabled &&
        plus.publicCap !== null && (
          <span class="field-note">
            {plus.publicCount} of {plus.publicCap} public posts used
          </span>
        )
      )}
    </div>
  );

  // Mounted once for the WHOLE form group, never per kind: `first` and
  // `title-error` swap on every keystroke, and remounting the widget there
  // would throw away the token the user is waiting on.
  const turnstile = showForm && !savedAtCap && <TurnstileBox onToken={setToken} />;

  const body = () => {
    // A 201 that came back `capReached` is still the at-cap state, but the piece
    // is already stored — so this is the one branch where the dialog reports a
    // completed save rather than offering one. Handled before the switch so
    // "at-cap" itself stays a plain fallthrough to the form.
    if (savedAtCap && post?.kind === "cap-reached") {
      return (
        <div class="save-form">
          <div class="note">
            <span class="note-icon" aria-hidden="true">
              <GalleryIcon />
            </span>
            <div>
              <b>Saved unlisted.</b> Your public wall is full ({post.count} of {post.cap}) — make an
              older piece private to free a slot, or{" "}
              <button type="button" class="link-inline" onClick={() => (S.plusOpen.value = true)}>
                get Kaleidoscope Plus
              </button>{" "}
              for unlimited.
            </div>
          </div>
          <div class="save-actions">
            <button class="btn" onClick={close}>
              Back to canvas
            </button>
            <button
              class="btn btn-primary"
              onClick={() => {
                S.saveOpen.value = false;
                S.remixOf.value = null;
                S.navigate(`/p/${post.id}`);
              }}
            >
              Open it
            </button>
          </div>
        </div>
      );
    }

    switch (kind) {
      case "checking":
        return (
          <p class="save-checking mono" role="status">
            Checking your gallery…
          </p>
        );

      case "signed-out":
        return (
          <div class="save-signin">
            <p>
              Sign in to save your piece, get a shareable link, and let others remix it. Drawing
              &amp; download stay free without an account.
            </p>
            <a class="btn btn-primary" href={loginUrl(location.pathname)}>
              Sign in with Google
            </a>
            <p class="save-foot">Your drawing stays on the canvas while you sign in.</p>
          </div>
        );

      case "nothing-visible":
        return (
          <div class="save-form">
            <div class="note">
              <span class="note-icon" aria-hidden="true">
                <EyeOffIcon />
              </span>
              <div>
                <b>Nothing to save yet.</b>{" "}
                {/* The second sentence is only TRUE when there is hidden ink. An
                    empty canvas gets the headline alone rather than being told
                    about a layer it does not have. */}
                {S.strokeCount.value > 0
                  ? "Everything you drew is on a hidden layer. Show a layer, or draw something new."
                  : "Draw something, then save it to your gallery."}
              </div>
            </div>
            <div class="save-actions save-actions-split">
              {S.strokeCount.value > 0 && (
                <button
                  class="btn btn-primary"
                  onClick={() => {
                    // The layers panel belongs to T06c, which is a separate
                    // component with no signal in state.ts yet. A DOM event
                    // keeps this button honest without reaching into a file
                    // this task does not own; the panel (or App) listens.
                    window.dispatchEvent(new CustomEvent("kaleido:show-layers"));
                    close();
                  }}
                >
                  <LayersIcon /> Show layers
                </button>
              )}
              <button class="btn" onClick={close}>
                Back to canvas
              </button>
            </div>
          </div>
        );

      case "self-unchanged":
        if (editing) {
          return (
            <div class="save-form">
              {titleField}
              {visibilityField}
              <div class="save-actions">
                <button class="btn" onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </button>
                <button class="btn btn-primary" onClick={onPatch} disabled={busy || titleInvalid}>
                  {busy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          );
        }
        return (
          <div class="save-form">
            <p class="save-lede">This is exactly the piece you already saved.</p>
            <PieceCard
              meta={twin}
              fallbackTitle=""
              line={twin ? `You · ${twin.visibility} · ${twin.likes} like${twin.likes === 1 ? "" : "s"}` : "You"}
            />
            <div class="save-actions save-actions-split">
              <button
                class="btn"
                onClick={() => {
                  const id = preflight !== "pending" && preflight !== "failed" ? preflight.mine : null;
                  if (!id) return;
                  S.saveOpen.value = false;
                  S.navigate(`/p/${id}`);
                }}
              >
                Open it
              </button>
              <button
                class="btn"
                onClick={() => {
                  setTitle(twin?.title ?? "");
                  setVisibility((twin?.visibility as Visibility) ?? "public");
                  setEditing(true);
                }}
              >
                Edit title &amp; visibility
              </button>
            </div>
            <hr class="hair" />
            <p class="save-foot">Make a change to save a new version.</p>
          </div>
        );

      case "other-unchanged": {
        const other = preflight !== "pending" && preflight !== "failed" ? preflight.other : null;
        return (
          <div class="save-form">
            <p class="save-lede">This exact drawing is already in the gallery.</p>
            <PieceCard
              meta={twin}
              fallbackTitle={other?.title ?? ""}
              line={`by ${twinAuthor ?? other?.author ?? "someone else"}${twin ? ` · ${twin.visibility}` : ""}`}
            />
            <hr class="hair" />
            <p>Make a change to save your version — anything counts.</p>
            <div class="save-actions">
              <button class="btn" onClick={close}>
                Back to canvas
              </button>
              <button class="btn btn-primary" disabled>
                Save piece
              </button>
            </div>
          </div>
        );
      }

      case "duplicate-other":
      case "duplicate-other-private": {
        const of = post?.kind === "duplicate-other" ? post.of : null;
        return (
          <div class="save-form">
            {titleField}
            {visibilityField}
            <div class="note note-alert">
              <span class="note-icon" aria-hidden="true">
                {of ? <GalleryIcon /> : <LockIcon />}
              </span>
              <div>
                {of ? (
                  <>
                    This exact drawing is already in the gallery as{" "}
                    <a class="link" href={`/p/${of}`}>
                      {twin?.title ?? "another piece"}
                    </a>
                    {twinAuthor ? ` by ${twinAuthor}` : ""}. Make a change to save your version.
                  </>
                ) : (
                  // No link and no author, because there is genuinely nothing to
                  // name: the twin is private and the API withholds it rather
                  // than leaking that it exists.
                  <>
                    Someone already has this exact drawing in their private collection, so it can’t
                    be posted as is. Make a change to save your version.
                  </>
                )}
              </div>
            </div>
            <div class="save-actions">
              <button class="btn" onClick={close}>
                Back to canvas
              </button>
              <button class="btn btn-primary" disabled>
                Save piece
              </button>
            </div>
          </div>
        );
      }

      case "at-cap":
      case "first":
      case "title-error":
      case "self-changed":
      case "error":
        return (
          <div class="save-form">
            {titleField}
            {nameChips}
            {visibilityField}
            {turnstile}
            {kind === "error" && (
              <div class="note note-alert" role="alert">
                <span class="note-icon" aria-hidden="true">
                  <AlertIcon />
                </span>
                <div>
                  {hint ?? "Couldn’t reach the gallery. Your drawing is safe here — try again in a moment."}
                </div>
              </div>
            )}
            {kind !== "error" && hint && <p class="form-error">{hint}</p>}
            <div class="save-actions">
              {remixOfOwnChanged && remix && (
                <span class="save-remix-hint">
                  Remix of your <b>{remix.title}</b>
                </span>
              )}
              <button class="btn" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button class="btn btn-primary" onClick={onSave} disabled={busy || blocked}>
                {busy ? "Saving…" : primaryLabel(kind, capActive, remixOfOwnChanged)}
              </button>
            </div>
          </div>
        );
    }
  };

  return (
    <div class="overlay" onClick={close}>
      <div
        class="overlay-card"
        role="dialog"
        aria-modal="true"
        aria-label="Save to gallery"
        data-save-state={kind}
        tabIndex={-1}
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header class="overlay-head">
          <h2>Save to gallery</h2>
          <button class="icon-btn" aria-label="Close" onClick={close}>
            ✕
          </button>
        </header>
        {body()}
      </div>
    </div>
  );
}

/**
 * The Turnstile widget, as its own component so that MOUNTING it is what renders
 * it. The previous effect keyed on `user` alone, which was fine when the form
 * was the only body; now the card starts on a pre-flight placeholder and the
 * container element does not exist on the first pass.
 */
function TurnstileBox({ onToken }: { onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const siteKey = getTurnstileSiteKey() ?? "1x00000000000000000000AA";
    let widgetId: string | undefined;
    renderTurnstile(ref.current, siteKey, onToken, S.bg.value)
      .then((id) => (widgetId = id))
      .catch(() => setFailed(true));
    return () => {
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, []);

  return (
    <>
      <div class="ts-widget" ref={ref} />
      {failed && <p class="form-error">Couldn’t load verification. Check your connection.</p>}
    </>
  );
}

/** Thumbnail + title + a mono line. Used by both "already exists" states. */
function PieceCard({
  meta,
  fallbackTitle,
  line,
}: {
  meta: ArtworkMeta | null;
  fallbackTitle: string;
  line: string;
}) {
  return (
    <div class="note piece-card">
      <span class="piece-thumb" aria-hidden="true">
        {meta && <img src={meta.urls.thumb} alt="" />}
      </span>
      <div>
        <div class="piece-title">{meta?.title || fallbackTitle || "Your piece"}</div>
        <div class="piece-line mono">{line}</div>
      </div>
    </div>
  );
}

const SparkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m12 3 2 5.6L19.5 11 14 13.4 12 19l-2-5.6L4.5 11 10 8.6z" />
  </svg>
);

const LockIcon = (): JSX.Element => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="4" y="10" width="16" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);

const AlertIcon = (): JSX.Element => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 8.5 7 7M15.5 8.5l-7 7" />
  </svg>
);
