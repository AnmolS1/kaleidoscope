-- Kaleidoscope 1.2: content hashing (dedupe), layer count, publication time
-- (the free public-post cap), and the entitlements table backing Plus.
--
-- ADDITIVE ONLY. 0002 had to rebuild `users` and `artworks` to drop a NOT NULL,
-- and doing so meant dropping the child table before the parent so the FK
-- cascade wouldn't wipe every artwork (see the note at the top of 0002 and the
-- README). Nothing here needs a rebuild, so nothing here takes that risk.

ALTER TABLE artworks ADD COLUMN content_hash TEXT;   -- sha256 of the render-equivalent projection
ALTER TABLE artworks ADD COLUMN layers INTEGER NOT NULL DEFAULT 1;
ALTER TABLE artworks ADD COLUMN updated_at INTEGER;
ALTER TABLE artworks ADD COLUMN published_at INTEGER; -- first time this piece went public

-- Backfill: every currently-public row was published when it was created. This
-- matters because the cap counts `published_at >= CAP_EPOCH`, so a NULL here
-- would make an existing public piece uncountable rather than pre-epoch.
UPDATE artworks SET published_at = created_at WHERE visibility = 'public';

-- Dedupe is per user: the same drawing by two people is two pieces. Partial so
-- the legacy rows (content_hash NULL until the T02c backfill runs) don't all
-- collide on NULL.
CREATE UNIQUE INDEX idx_art_user_hash ON artworks(user_id, content_hash) WHERE content_hash IS NOT NULL;
-- Cross-user lookup for the remix block + save pre-flight.
CREATE INDEX idx_art_hash ON artworks(content_hash);
-- Covers the conditional-publish counter (user + visibility + published_at).
CREATE INDEX idx_art_published ON artworks(user_id, visibility, published_at);

CREATE TABLE entitlements (
  source      TEXT NOT NULL,                 -- 'apple' | 'lemonsqueezy' | 'comp'
  external_id TEXT NOT NULL,                 -- originalTransactionId | LS order id | 'comp:<user_id>'
  -- SET NULL rather than CASCADE: a deleted account must not erase the record of
  -- a real purchase, which support and refunds still need to reason about.
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  product     TEXT NOT NULL,                 -- 'plus'
  environment TEXT,                          -- 'Production' | 'Sandbox' | NULL
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (source, external_id)
);

CREATE INDEX idx_ent_user ON entitlements(user_id);
