import { useEffect, useState } from "preact/hooks";
import * as S from "../state";
import {
  ApiError,
  getArtwork,
  getArtworkVector,
  likeArtwork,
  type ArtworkMeta,
} from "../api";
import { contentHash, deserialize, type DrawingV2 } from "../../shared/vector";
import { exportPNG, exportSVG, downloadBlob } from "../engine/export";
import { PageNav } from "./PageNav";
import { Avatar } from "./Avatar";
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
  const [drawing, setDrawing] = useState<DrawingV2 | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // Separate from `error`: the METADATA loading is what decides whether there is
  // a page at all. The vector only decides whether it can be remixed or
  // downloaded, and when it fails those three buttons go disabled with nothing
  // on screen saying why.
  const [vectorError, setVectorError] = useState<string | null>(null);
  const [likes, setLikes] = useState(0);

  useEffect(() => {
    let alive = true;
    setMetaState(null);
    setError(false);
    setVectorError(null);
    setHash(null);
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
      .then(async (json) => {
        if (!alive) return;
        setDrawing(deserialize(json));
        // The save dialog uses this to tell "remixed and changed" from "remixed
        // and untouched". crypto.subtle is undefined outside a secure context,
        // so this can legitimately fail — a missing hash just turns the check
        // off rather than blocking the remix.
        try {
          const h = await contentHash(json);
          if (alive) setHash(h);
        } catch {
          /* no hash available here */
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const code = e instanceof ApiError ? e.code : "vector_unavailable";
        setVectorError(
          code === "upgrade_required"
            ? "This piece uses features this page cannot open yet."
            : "The drawing data could not be loaded, so this piece cannot be remixed or downloaded.",
        );
      });
    return () => {
      alive = false;
      document.title = "Kaleidoscope — draw mandalas";
    };
  }, [id]);

  function onRemix() {
    if (!drawing) return;
    S.pendingRemix.value = drawing;
    S.remixOf.value = id;
    S.remixSourceHash.value = hash;
    S.remixSourceMeta.value = meta
      ? { id, title: meta.title, isOwner: meta.isOwner, likes: meta.likes }
      : null;
    S.navigate("/");
  }

  async function onLike() {
    if (!S.me.value) return;
    try {
      const r = await likeArtwork(id);
      setLikes(r.likes);
      S.announce(`Liked. ${r.likes} like${r.likes === 1 ? "" : "s"}`);
    } catch {
      /* ignore */
    }
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  if (error) {
    return (
      <div class="page">
        <PageNav />
        <main id="main-content" class="page-body">
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
      <main id="main-content" class="page-body artwork">
        <div class="artwork-frame">
          <img src={`/api/artworks/${id}/image`} alt={meta?.altText ?? meta?.title ?? "Artwork"} />
        </div>
        <div class="artwork-side">
          <h1>{meta?.title ?? "…"}</h1>
          {meta?.author?.name && (
            <p class="artwork-author">
              <Avatar src={meta.author.avatar} name={meta.author.name} size={24} />
              by {meta.author.name}
            </p>
          )}
          {meta && (
            <p class="artwork-meta">
              {/* segments === 0 is the stored marker for "the visible layers
                  disagree" — there is no single fold to name, so the piece is
                  described as layered instead of as "0-fold". */}
              {meta.segments === 0
                ? // The gallery card prints the count; this line dropped it, so
                  // the same piece described itself two ways depending on where
                  // you read it. Absent (an older worker never sent the field) it
                  // stays a bare "Layered" rather than claiming zero layers.
                  meta.layers
                  ? `Layered · ${meta.layers} layers`
                  : "Layered symmetry"
                : `${meta.segments}-fold ${meta.mirror ? "mirror" : "rotational"} symmetry`}
              {meta.remixOf && (
                <>
                  {" · "}
                  <Link href={`/p/${meta.remixOf}`} class="link">remix of another piece</Link>
                </>
              )}
            </p>
          )}

          {vectorError && <p class="form-error">{vectorError}</p>}

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
