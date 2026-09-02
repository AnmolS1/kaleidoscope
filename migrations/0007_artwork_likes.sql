-- One like per person per piece (REVIEW.md minor: "likes are unbounded per
-- user").
--
-- `artworks.likes` was a bare counter that the like route incremented on every
-- POST, with no record of WHO. A single account could press the button all day
-- — the hourly rate limit shaped that into a slower climb, it did not cap it —
-- so the number under a piece measured determination, not popularity.
--
-- This table is the missing half. The counter stays: it is what the gallery,
-- the permalink and the OG card read, and denormalizing it is what keeps a
-- gallery page one query instead of one per row. The table decides whether a
-- given press is allowed to move it.
--
-- Two notes for whoever reads this next:
--
--  1. LIKES RECORDED BEFORE THIS MIGRATION ARE UNATTRIBUTED. There is nothing
--     to backfill from — the rows never existed — so the historical counts
--     stand as they are, and a user who had already liked a piece can like it
--     once more. That is a one-time, bounded discrepancy and the alternative
--     (resetting every count to zero) throws away real signal to fix an
--     accounting detail nobody can observe.
--  2. There is deliberately no UNLIKE. The route is idempotent: the first press
--     counts, later ones return the current total unchanged. Adding an unlike
--     is a product decision with a UI attached, not a defect fix.
CREATE TABLE IF NOT EXISTS artwork_likes (
  artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artwork_id, user_id)
);

-- "What has this person liked", for a future you-liked-this indicator and for
-- the cascade to have an index to work from.
CREATE INDEX IF NOT EXISTS idx_likes_user ON artwork_likes(user_id);
