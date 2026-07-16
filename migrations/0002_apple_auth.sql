-- Sign in with Apple: make users.google_sub nullable (Apple-only users have no
-- Google identity) and add users.apple_sub (UNIQUE, NULL-safe). SQLite can't
-- drop a NOT NULL constraint in place, so we rebuild the users table.
--
-- DATA-SAFETY NOTE: artworks.user_id references users(id) ON DELETE CASCADE. If
-- foreign-key enforcement is ON, `DROP TABLE users` performs an implicit DELETE
-- that cascades and wipes every artwork (verified against SQLite). `PRAGMA
-- defer_foreign_keys` does NOT prevent this — deferral delays constraint CHECKS,
-- not cascade ACTIONS. So we also rebuild `artworks` and drop the child BEFORE
-- the parent: once the new artworks table references the new users table, the
-- old users table has no live children and its drop cascades to nothing. This
-- is correct whether or not D1 enforces FKs during the migration.

PRAGMA defer_foreign_keys = true;

-- 1. New users: google_sub nullable + apple_sub added. Keep every other column.
CREATE TABLE users_new (
  id           TEXT PRIMARY KEY,
  google_sub   TEXT,                              -- nullable now (Apple-only users)
  apple_sub    TEXT,                              -- Apple's stable subject id
  email        TEXT,
  name         TEXT,
  avatar_url   TEXT,
  role         TEXT NOT NULL DEFAULT 'user',
  flagged      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
INSERT INTO users_new (id, google_sub, apple_sub, email, name, avatar_url, role, flagged, created_at, last_seen_at)
  SELECT id, google_sub, NULL, email, name, avatar_url, role, flagged, created_at, last_seen_at FROM users;

-- 2. Rebuild artworks to reference the new users table (schema otherwise identical).
CREATE TABLE artworks_new (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users_new(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'Untitled',
  visibility  TEXT NOT NULL DEFAULT 'public',
  image_key   TEXT NOT NULL,
  thumb_key   TEXT NOT NULL,
  vector_key  TEXT NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  segments    INTEGER NOT NULL,
  mirror      INTEGER NOT NULL,
  palette     TEXT,
  remix_of    TEXT REFERENCES artworks_new(id) ON DELETE SET NULL,
  likes       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
INSERT INTO artworks_new
  SELECT id, user_id, title, visibility, image_key, thumb_key, vector_key,
         width, height, segments, mirror, palette, remix_of, likes, created_at
  FROM artworks;

-- 3. Drop the child first, then the (now childless) parent.
DROP TABLE artworks;
DROP TABLE users;

-- 4. Swap in the new tables. RENAME rewrites the FK references in artworks_new
--    (users_new -> users, artworks_new -> artworks) automatically.
ALTER TABLE users_new RENAME TO users;
ALTER TABLE artworks_new RENAME TO artworks;

-- 5. Recreate indexes. UNIQUE indexes allow multiple NULLs in SQLite, so no
--    partial WHERE clause is needed for the Apple-only / Google-only cases.
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub);
CREATE UNIQUE INDEX idx_users_apple_sub  ON users(apple_sub);
CREATE INDEX idx_art_public ON artworks(visibility, created_at DESC);
CREATE INDEX idx_art_user   ON artworks(user_id, created_at DESC);
