-- Kaleidoscope initial schema: users + artwork metadata.
-- Vector JSON + renders live in R2; this DB holds queryable metadata only.

CREATE TABLE users (
  id           TEXT PRIMARY KEY,                 -- uuid v4
  google_sub   TEXT UNIQUE NOT NULL,
  email        TEXT,
  name         TEXT,
  avatar_url   TEXT,
  role         TEXT NOT NULL DEFAULT 'user',     -- 'user' | 'admin'
  flagged      INTEGER NOT NULL DEFAULT 0,       -- manual trust flag (curation / perks / future limits)
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE artworks (
  id          TEXT PRIMARY KEY,                  -- short nanoid, used in the permalink
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'Untitled',
  visibility  TEXT NOT NULL DEFAULT 'public',    -- 'public' | 'unlisted' | 'private'
  image_key   TEXT NOT NULL,                     -- R2: rendered webp
  thumb_key   TEXT NOT NULL,                     -- R2: small webp
  vector_key  TEXT NOT NULL,                     -- R2: gzipped stroke json (source of truth)
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  segments    INTEGER NOT NULL,
  mirror      INTEGER NOT NULL,                  -- 0/1
  palette     TEXT,                              -- json array of hex used
  remix_of    TEXT REFERENCES artworks(id) ON DELETE SET NULL,
  likes       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_art_public ON artworks(visibility, created_at DESC);
CREATE INDEX idx_art_user   ON artworks(user_id, created_at DESC);
