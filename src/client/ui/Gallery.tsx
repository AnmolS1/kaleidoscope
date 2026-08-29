import { useEffect, useState } from "preact/hooks";
import * as S from "../state";
import {
  ApiError,
  getGallery,
  getMyArtworks,
  deleteArtwork,
  patchArtwork,
  type GalleryItem,
} from "../api";
import { PageNav } from "./PageNav";
import { Avatar } from "./Avatar";
import { Link } from "./Link";

export function Gallery({ mine }: { mine: boolean }) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  /** Per-piece "the public wall is full" line, keyed by artwork id. */
  const [capped, setCapped] = useState<Record<string, { cap: number; count: number }>>({});

  async function load(reset = false) {
    setLoading(true);
    try {
      const fetcher = mine ? getMyArtworks : getGallery;
      const res = await fetcher(reset ? null : cursor);
      setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
      setCursor(res.nextCursor);
      setDone(!res.nextCursor);
      if (!reset && res.items.length > 0) {
        S.announce(`${res.items.length} more piece${res.items.length === 1 ? "" : "s"} loaded`);
      }
    } catch {
      setDone(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setDone(false);
    load(true);
  }, [mine]);

  async function onDelete(id: string) {
    if (!confirm("Delete this piece? This can't be undone.")) return;
    await deleteArtwork(id).catch(() => {});
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  /**
   * Change one piece's visibility.
   *
   * Two things this must NOT do, both of which it used to. It swallowed every
   * error and then applied the optimistic update anyway, so a rejected PATCH
   * left the select showing a visibility the server had refused — the user's
   * next reload silently undid it. And `402 cap_reached` — the whole point of
   * the cap being a CURRENT count rather than a lifetime allowance — arrived as
   * a caught-and-dropped exception, so going public at the cap looked like it
   * worked. Now the select snaps back and says why.
   */
  async function onVisibility(id: string, visibility: string) {
    const previous = items.find((i) => i.id === id)?.visibility;
    try {
      await patchArtwork(id, { visibility });
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, visibility } : i)));
      setCapped((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (e) {
      // Re-render with the value the server still holds. `items` is the source
      // of truth for the <select>, so rewriting the same object is what forces
      // the DOM control back off the value the user just picked.
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, visibility: previous } : i)));
      if (e instanceof ApiError && e.status === 402 && e.code === "cap_reached") {
        const cap = typeof e.data.cap === "number" ? e.data.cap : 0;
        const count = typeof e.data.count === "number" ? e.data.count : 0;
        setCapped((prev) => ({ ...prev, [id]: { cap, count } }));
        S.announce(`Public wall is full, ${count} of ${cap}`);
      } else {
        S.announce("Couldn't change visibility — try again");
      }
    }
  }

  return (
    <div class="page">
      <PageNav />
      <main id="main-content" class="page-body">
        <div class="page-head">
          <h1>{mine ? "My pieces" : "Gallery"}</h1>
          {mine && !S.me.value && <p>Sign in to see your saved pieces.</p>}
        </div>

        {items.length === 0 && !loading ? (
          <p class="empty">
            {mine ? "No pieces yet — " : "Nothing here yet — "}
            <Link href="/" class="link">go make one</Link>.
          </p>
        ) : (
          <div class="masonry">
            {items.map((it) => (
              <figure class="art-card" key={it.id}>
                <Link href={`/p/${it.id}`} aria-label={it.title}>
                  <img src={it.thumb} alt={it.altText ?? it.title} loading="lazy" />
                </Link>
                <figcaption>
                  <span class="art-title">{it.title}</span>
                  {mine ? (
                    <span class="art-controls">
                      <select
                        value={it.visibility}
                        aria-label="Visibility"
                        onChange={(e) => onVisibility(it.id, (e.target as HTMLSelectElement).value)}
                      >
                        {/* Disabled rather than hidden: the option has to stay
                            visible for the message beneath to make sense. */}
                        <option value="public" disabled={!!capped[it.id] && it.visibility !== "public"}>
                          Public
                        </option>
                        <option value="unlisted">Unlisted</option>
                        <option value="private">Private</option>
                      </select>
                      <button class="link-danger" onClick={() => onDelete(it.id)} aria-label={`Delete ${it.title}`}>
                        Delete
                      </button>
                      {capped[it.id] && (
                        <span class="art-cap" role="status">
                          Public wall is full ({capped[it.id].count} of {capped[it.id].cap}). Make
                          another piece private to free a slot, or{" "}
                          <button
                            type="button"
                            class="link-inline"
                            onClick={() => (S.plusOpen.value = true)}
                          >
                            get Plus
                          </button>
                          .
                        </span>
                      )}
                    </span>
                  ) : (
                    it.author?.name && (
                      <span class="art-author">
                        <Avatar src={it.author.avatar} name={it.author.name} size={20} />
                        by {it.author.name}
                      </span>
                    )
                  )}
                  {/* `segments === 0` is the contract signal for "the visible
                      layers disagree", so the piece is LAYERED — printing
                      "0-fold" would be a lie about the drawing. Undefined means
                      an older response that never carried the field, which is
                      why this is `=== 0` and not falsy. */}
                  {it.segments !== undefined && (
                    <span class="art-sym mono">
                      {it.segments === 0
                        ? `Layered · ${it.layers ?? 0} layers`
                        : `${it.segments}-fold · ${it.mirror ? "mirrored" : "rotational"}`}
                    </span>
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
        )}

        {!done && items.length > 0 && (
          <div class="load-more">
            <button class="btn" onClick={() => load(false)} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
