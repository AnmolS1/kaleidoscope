import { useEffect, useState } from "preact/hooks";
import * as S from "../state";
import { getGallery, getMyArtworks, deleteArtwork, patchArtwork, type GalleryItem } from "../api";
import { PageNav } from "./PageNav";
import { Avatar } from "./Avatar";
import { Link } from "./Link";

export function Gallery({ mine }: { mine: boolean }) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);

  async function load(reset = false) {
    setLoading(true);
    try {
      const fetcher = mine ? getMyArtworks : getGallery;
      const res = await fetcher(reset ? null : cursor);
      setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
      setCursor(res.nextCursor);
      setDone(!res.nextCursor);
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

  async function onVisibility(id: string, visibility: string) {
    await patchArtwork(id, { visibility }).catch(() => {});
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, visibility } : i)));
  }

  return (
    <div class="page">
      <PageNav />
      <main class="page-body">
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
                  <img src={it.thumb} alt={it.title} loading="lazy" />
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
                        <option value="public">Public</option>
                        <option value="unlisted">Unlisted</option>
                        <option value="private">Private</option>
                      </select>
                      <button class="link-danger" onClick={() => onDelete(it.id)} aria-label={`Delete ${it.title}`}>
                        Delete
                      </button>
                    </span>
                  ) : (
                    it.author?.name && (
                      <span class="art-author">
                        <Avatar src={it.author.avatar} name={it.author.name} size={20} />
                        by {it.author.name}
                      </span>
                    )
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
