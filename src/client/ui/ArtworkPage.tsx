import { useEffect, useState } from "preact/hooks";
import * as S from "../state";
import {
  getArtwork,
  getArtworkVector,
  likeArtwork,
  type ArtworkMeta,
} from "../api";
import { deserialize, type Drawing } from "../engine/strokes";
import { exportPNG, exportSVG, downloadBlob } from "../engine/export";
import { PageNav } from "./PageNav";
import { Link } from "./Link";

function setMeta(property: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("property", property);
    document.head.appendChild(el);
  }
  el.content = content;
}

export function ArtworkPage({ id }: { id: string }) {
  const [meta, setMetaState] = useState<ArtworkMeta | null>(null);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [error, setError] = useState(false);
  const [likes, setLikes] = useState(0);

  useEffect(() => {
    let alive = true;
    setMetaState(null);
    setError(false);
    getArtwork(id)
      .then((m) => {
        if (!alive) return;
        setMetaState(m);
        setLikes(m.likes);
        document.title = `${m.title} — Kaleidoscope`;
        const base = location.origin;
        setMeta("og:title", `${m.title} — Kaleidoscope`);
        setMeta("og:image", `${base}/og/${m.id}`);
        setMeta("og:url", `${base}/p/${m.id}`);
        setMeta("twitter:card", "summary_large_image");
      })
      .catch(() => alive && setError(true));
    getArtworkVector(id)
      .then((json) => alive && setDrawing(deserialize(json)))
      .catch(() => {});
    return () => {
      alive = false;
      document.title = "Kaleidoscope — draw mandalas";
    };
  }, [id]);

  function onRemix() {
    if (!drawing) return;
    S.pendingRemix.value = drawing;
    S.remixOf.value = id;
    S.navigate("/");
  }

  async function onLike() {
    if (!S.me.value) return;
    try {
      const r = await likeArtwork(id);
      setLikes(r.likes);
    } catch {
      /* ignore */
    }
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  if (error) {
    return (
      <div class="page">
        <PageNav />
        <main class="page-body">
          <p class="empty">
            This piece isn't available. <Link href="/gallery" class="link">Browse the gallery</Link>.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div class="page">
      <PageNav />
      <main class="page-body artwork">
        <div class="artwork-frame">
          <img src={`/api/artworks/${id}/image`} alt={meta?.title ?? "Artwork"} />
        </div>
        <div class="artwork-side">
          <h1>{meta?.title ?? "…"}</h1>
          {meta?.author?.name && <p class="artwork-author">by {meta.author.name}</p>}
          {meta && (
            <p class="artwork-meta">
              {meta.segments}-fold {meta.mirror ? "mirror" : "rotational"} symmetry
              {meta.remixOf && (
                <>
                  {" · "}
                  <Link href={`/p/${meta.remixOf}`} class="link">remix of another piece</Link>
                </>
              )}
            </p>
          )}

          <div class="artwork-actions">
            <button class="btn btn-primary" onClick={onRemix} disabled={!drawing}>
              Remix
            </button>
            <button class="btn" onClick={onLike} disabled={!S.me.value} aria-label="Like">
              ♥ {likes}
            </button>
          </div>

          <div class="artwork-downloads">
            <span class="downloads-label">Download</span>
            <button class="btn btn-ghost" disabled={!drawing} onClick={async () => drawing && downloadBlob(await exportPNG(drawing, 2), `kaleidoscope-${stamp()}@2x.png`, "image/png")}>
              PNG
            </button>
            <button class="btn btn-ghost" disabled={!drawing} onClick={() => drawing && downloadBlob(exportSVG(drawing), `kaleidoscope-${stamp()}.svg`)}>
              SVG
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
