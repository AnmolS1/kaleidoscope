-- Tombstone refunded entitlements instead of deleting them (REVIEW.md M1, M2).
--
-- Deleting the row left no memory that the purchase had ever been revoked, and
-- both billing paths hand the client a credential it keeps:
--
--   Apple  — the device already holds a JWS signed BEFORE the refund, so it
--            carries no revocationDate and passes verification. Buy, save the
--            JWS, refund, re-POST it: re-granted. Money back and Plus, on
--            repeat.
--   LS     — `order_created` is retried for up to three days and can be resent
--            by hand from the dashboard. The retry is byte-identical with a
--            valid signature, so a refund followed by a retry re-grants.
--
-- A tombstone is the fix for both: the row survives the refund, the grant paths
-- refuse to resurrect it, and the entitlement queries ignore it.
ALTER TABLE entitlements ADD COLUMN revoked_at INTEGER;

-- Reads filter on (user_id, product) and now also on revoked_at; keeping the
-- tombstoned rows out of the index keeps the common case the same size it was.
CREATE INDEX IF NOT EXISTS idx_ent_user_live
  ON entitlements(user_id, product) WHERE revoked_at IS NULL;
