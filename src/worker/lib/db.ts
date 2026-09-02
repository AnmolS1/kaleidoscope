// D1 data access for users + artworks. Keyset pagination on (created_at, id).

import { envFlag } from "./validate";
import type { Env, User, Artwork, Visibility, PlusSource } from "../types";
import { newUserId } from "./ids";

export async function upsertUser(
  env: Env,
  profile: { google_sub: string; email?: string | null; name?: string | null; avatar_url?: string | null },
): Promise<User> {
  const now = Date.now();
  const existing = await env.DB.prepare("SELECT * FROM users WHERE google_sub = ?")
    .bind(profile.google_sub)
    .first<User>();

  if (existing) {
    await env.DB.prepare(
      "UPDATE users SET email=?, name=?, avatar_url=?, last_seen_at=? WHERE id=?",
    )
      .bind(profile.email ?? null, profile.name ?? null, profile.avatar_url ?? null, now, existing.id)
      .run();
    return { ...existing, email: profile.email ?? null, name: profile.name ?? null, avatar_url: profile.avatar_url ?? null, last_seen_at: now };
  }

  const id = newUserId();
  await env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, name, avatar_url, role, flagged, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 'user', 0, ?, ?)`,
  )
    .bind(id, profile.google_sub, profile.email ?? null, profile.name ?? null, profile.avatar_url ?? null, now, now)
    .run();
  return {
    id,
    google_sub: profile.google_sub,
    apple_sub: null,
    email: profile.email ?? null,
    name: profile.name ?? null,
    avatar_url: profile.avatar_url ?? null,
    role: "user",
    flagged: 0,
    created_at: now,
    last_seen_at: now,
  };
}

export function getUserById(env: Env, id: string): Promise<User | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

export function getUserByAppleSub(env: Env, apple_sub: string): Promise<User | null> {
  return env.DB.prepare("SELECT * FROM users WHERE apple_sub = ?").bind(apple_sub).first<User>();
}

/** Look up a user by (verified) email — used to link Apple to an existing Google
 *  account instead of creating a duplicate. Case-insensitive. */
export function getUserByEmail(env: Env, email: string): Promise<User | null> {
  return env.DB.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").bind(email).first<User>();
}

/**
 * Resolve an Apple sign-in to a user. Apple only sends name/email on the FIRST
 * authorization, so we fill missing fields (COALESCE) but never overwrite an
 * existing value with null on later sign-ins.
 */
export async function upsertAppleUser(
  env: Env,
  profile: { apple_sub: string; email?: string | null; name?: string | null },
): Promise<User> {
  const now = Date.now();
  const existing = await getUserByAppleSub(env, profile.apple_sub);
  if (existing) {
    await env.DB.prepare(
      "UPDATE users SET email=COALESCE(email, ?), name=COALESCE(name, ?), last_seen_at=? WHERE id=?",
    )
      .bind(profile.email ?? null, profile.name ?? null, now, existing.id)
      .run();
    return {
      ...existing,
      email: existing.email ?? profile.email ?? null,
      name: existing.name ?? profile.name ?? null,
      last_seen_at: now,
    };
  }

  const id = newUserId();
  await env.DB.prepare(
    `INSERT INTO users (id, google_sub, apple_sub, email, name, avatar_url, role, flagged, created_at, last_seen_at)
     VALUES (?, NULL, ?, ?, ?, NULL, 'user', 0, ?, ?)`,
  )
    .bind(id, profile.apple_sub, profile.email ?? null, profile.name ?? null, now, now)
    .run();
  return {
    id,
    google_sub: null,
    apple_sub: profile.apple_sub,
    email: profile.email ?? null,
    name: profile.name ?? null,
    avatar_url: null,
    role: "user",
    flagged: 0,
    created_at: now,
    last_seen_at: now,
  };
}

/** Attach an Apple identity to an existing (e.g. Google) user, filling in any
 *  missing name/email but never clobbering existing values. */
export async function linkAppleToUser(
  env: Env,
  userId: string,
  apple_sub: string,
  extra: { email?: string | null; name?: string | null } = {},
): Promise<User> {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE users SET apple_sub=?, email=COALESCE(email, ?), name=COALESCE(name, ?), last_seen_at=? WHERE id=?",
  )
    .bind(apple_sub, extra.email ?? null, extra.name ?? null, now, userId)
    .run();
  const user = await getUserById(env, userId);
  if (!user) throw new Error("user vanished during apple link");
  return user;
}

/** All artwork ids owned by a user — used to clean up R2 blobs before the FK
 *  cascade removes the rows on user deletion. */
export async function listArtworkIdsByUser(env: Env, userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT id FROM artworks WHERE user_id = ?")
    .bind(userId)
    .all<{ id: string }>();
  return (results ?? []).map((r) => r.id);
}

/** Delete a user row. artworks rows cascade (FK ON DELETE CASCADE); R2 blobs and
 *  KV sessions are handled by the caller. */
export async function deleteUser(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
}

/** Point a user's avatar_url at our cached path (or clear it). */
export async function setUserAvatar(env: Env, id: string, path: string | null): Promise<void> {
  await env.DB.prepare("UPDATE users SET avatar_url=? WHERE id=?").bind(path, id).run();
}

export interface NewArtwork {
  id: string;
  user_id: string;
  title: string;
  visibility: Visibility;
  image_key: string;
  thumb_key: string;
  vector_key: string;
  width: number;
  height: number;
  segments: number;
  mirror: number;
  palette: string | null;
  remix_of: string | null;
  created_at: number;
  alt_text: string;
  /** NULL when the drawing has nothing visible: every such piece renders the
   *  same blank picture, so a shared hash would dedupe unrelated work. The
   *  unique index is partial (`WHERE content_hash IS NOT NULL`) and exempts it. */
  content_hash: string | null;
  layers: number;
}

/** Thrown when the (user_id, content_hash) unique index rejects an insert — the
 *  same user already has this exact drawing. The caller turns it into a dedupe
 *  response rather than a 500. */
export class DuplicateHashError extends Error {}

export async function insertArtwork(env: Env, a: NewArtwork): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO artworks
        (id, user_id, title, visibility, image_key, thumb_key, vector_key, width, height, segments, mirror, palette, remix_of, likes, created_at, alt_text, content_hash, layers, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
      .bind(
        a.id, a.user_id, a.title, a.visibility, a.image_key, a.thumb_key, a.vector_key,
        a.width, a.height, a.segments, a.mirror, a.palette, a.remix_of, a.created_at, a.alt_text,
        a.content_hash, a.layers, a.created_at,
      )
      .run();
  } catch (e) {
    // The read-then-insert dedupe check above this is not atomic, so two saves
    // of the same drawing in flight together both pass it and one loses here.
    // The index is the actual guarantee; this converts losing the race into the
    // same answer the checked path gives.
    // MATCH THE DEDUPE INDEX SPECIFICALLY (S5).
    //
    // `/UNIQUE|constraint/i` also matched a primary-key collision and every
    // foreign-key failure. The caller treats a DuplicateHashError as "this is
    // the same drawing" and calls `deleteArtworkObjects(id)` — so a FK error
    // made the save path DESTROY an existing artwork's R2 blobs.
    //
    // Matched on the COLUMNS, not on the index name: SQLite does not put the
    // index name in the message. It says
    //   UNIQUE constraint failed: artworks.user_id, artworks.content_hash
    // for the dedupe index and
    //   UNIQUE constraint failed: artworks.id
    // for the primary key. Matching `idx_art_user_hash` — the obvious reading
    // of "match the index by name" — would have matched NOTHING, turning every
    // genuine duplicate into a 500. `content_hash` appears in no other unique
    // index, so requiring both words is specific without being brittle about
    // the exact phrasing.
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique/i.test(msg) && /content_hash/i.test(msg)) throw new DuplicateHashError(msg);
    throw e;
  }
}

/** This user's existing piece with the same render-equivalent hash, if any.
 *  Same user + same hash is a dedupe, never a new piece. */
export function findOwnByHash(env: Env, userId: string, hash: string): Promise<Artwork | null> {
  return env.DB.prepare("SELECT * FROM artworks WHERE user_id = ? AND content_hash = ?")
    .bind(userId, hash)
    .first<Artwork>();
}

export interface HashMatch {
  id: string;
  title: string;
  visibility: Visibility;
  author_name: string | null;
}

/**
 * Another user's piece with this hash — the remix block and the save pre-flight.
 *
 * Prefers a viewable (non-private) match, because that is the one whose id we
 * are allowed to name. `ORDER BY (visibility='private')` puts non-private rows
 * first, then oldest wins: the first person to save a drawing is the one it is
 * attributed to.
 */
export function findOtherByHash(env: Env, userId: string, hash: string): Promise<HashMatch | null> {
  return env.DB.prepare(
    `SELECT a.id, a.title, a.visibility, u.name AS author_name
     FROM artworks a JOIN users u ON u.id = a.user_id
     WHERE a.content_hash = ? AND a.user_id != ?
     ORDER BY (a.visibility = 'private'), a.created_at ASC
     LIMIT 1`,
  )
    .bind(hash, userId)
    .first<HashMatch>();
}

/**
 * Publish a piece if the user is under their public cap — one statement, so the
 * count and the write cannot drift apart the way a read-then-write can.
 *
 * Returns false when the cap blocked it (`meta.changes === 0`).
 *
 * The cap is 10 CONCURRENTLY-public pieces, not 10 publications ever (settled
 * 2026-08-28): the subquery counts currently-public rows, so taking a piece
 * down deliberately gives the slot back.
 *
 * `published_at` is a different question and is COALESCEd, so it keeps
 * recording FIRST publication. That timestamp is what `>= epoch` tests, which
 * is what keeps pre-epoch pieces grandfathered — restamping it on re-publish
 * would drag one over the epoch and charge the user for something they already
 * had.
 *
 * Callers MUST short-circuit an already-public row: at exactly the cap the
 * subquery counts the row being updated, so an idempotent re-publish would see
 * `cap < cap` and report itself blocked.
 */
export async function publishArtwork(
  env: Env,
  opts: { id: string; userId: string; cap: number; epoch: number; now: number },
): Promise<boolean> {
  const res = await env.DB.prepare(
    // The `user_id` and `visibility` guards are not redundant with the route's
    // ownership check (S4). This one statement IS the cap enforcement, and
    // without them it would publish any row while counting whichever user's
    // quota it was handed — two different users in one statement, which is
    // exactly the shape that turns a routing slip into a cross-account write.
    // `visibility != 'public'` also keeps a re-publish from consuming a second
    // slot against the same piece.
    `UPDATE artworks
       SET visibility = 'public', published_at = COALESCE(published_at, ?), updated_at = ?
     WHERE id = ?
       AND user_id = ?
       AND visibility != 'public'
       AND (
         -- A piece first published BEFORE the epoch never occupies a slot, so
         -- re-publishing it cannot need one (S3). Without this the app's own
         -- advice — "make an older piece private to free a slot" — could strand
         -- that piece at 402 permanently: it frees nothing when hidden, because
         -- it never counted, and then cannot come back because the user is at
         -- cap. COALESCE above already keeps its original published_at, so this
         -- branch cannot be used to smuggle a new piece in under the cap.
         (published_at IS NOT NULL AND published_at < ?)
         OR (SELECT COUNT(*) FROM artworks
             WHERE user_id = ? AND visibility = 'public' AND published_at >= ?) < ?
       )`,
  )
    .bind(opts.now, opts.now, opts.id, opts.userId, opts.epoch, opts.userId, opts.epoch, opts.cap)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** How many of this user's pieces currently occupy a public slot. Mirrors the
 *  predicate in publishArtwork exactly — if these two ever disagree the counter
 *  shown in the UI stops describing the cap that is actually enforced. */
export async function countPublicSince(env: Env, userId: string, epoch: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM artworks WHERE user_id = ? AND visibility = 'public' AND published_at >= ?",
  )
    .bind(userId, epoch)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Rows still missing a content hash (everything saved before 1.2), for the
 *  T02c backfill. Until it finishes the remix block is off for those pieces. */
export async function listArtworksMissingHash(env: Env, limit: number): Promise<Artwork[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM artworks WHERE content_hash IS NULL ORDER BY created_at DESC LIMIT ?",
  )
    .bind(limit)
    .all<Artwork>();
  return results ?? [];
}

/**
 * Set a backfilled hash + layer count. Idempotent, and tolerant of the unique
 * index rejecting it: legacy rows can contain genuine same-user duplicates that
 * predate the constraint, and one of those failing to acquire a hash is not a
 * reason to abort a backfill batch. Returns whether the row was updated.
 */
export async function setArtworkHash(
  env: Env,
  id: string,
  hash: string,
  layers: number,
): Promise<boolean> {
  try {
    const res = await env.DB.prepare(
      "UPDATE artworks SET content_hash = ?, layers = ? WHERE id = ? AND content_hash IS NULL",
    )
      .bind(hash, layers, id)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  } catch (e) {
    // Same narrowing as insertArtwork (S5): only the dedupe index means "this
    // row is a duplicate". A foreign-key failure reported as one would be
    // recorded as `duplicate_or_already_set` and quietly never retried.
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique/i.test(msg) && /content_hash/i.test(msg)) return false;
    throw e;
  }
}

// ---- entitlements --------------------------------------------------------

/** Every Plus source this user holds. Empty means no entitlement. */
/**
 * The predicate that decides whether an entitlement row still counts.
 *
 * Two conditions, both of which were missing and each of which was a way to
 * hold Plus you should not have:
 *
 *   `revoked_at IS NULL` — refunds tombstone rather than delete (REVIEW M1/M2),
 *   so a refunded purchase stops counting and cannot be resurrected by
 *   replaying the credential the client still holds.
 *
 *   the environment clause — a Sandbox purchase made during the review window
 *   used to be indistinguishable from a real one FOREVER: `environment` was
 *   written to the row and never read again (REVIEW M3).
 *
 * The Sandbox half is deliberately tied to `PLUS_ALLOW_SANDBOX` rather than
 * rejected outright. The review's suggested fix — accept only Production —
 * would break the review window it exists for: the reviewer buys in Sandbox, so
 * an unconditional filter means their purchase unlocks nothing and the app is
 * rejected for a purchase that "does not work". Tying it to the flag means
 * Sandbox counts exactly while we have said it may, and every Sandbox row stops
 * counting the moment the flag goes off — no cleanup deploy required, and no
 * window where a free Sandbox purchase is worth real money.
 */
function liveEntitlement(env: Env): string {
  return envFlag(env.PLUS_ALLOW_SANDBOX)
    ? "revoked_at IS NULL"
    : "revoked_at IS NULL AND (environment IS NULL OR environment = 'Production')";
}

export async function plusSources(env: Env, userId: string): Promise<PlusSource[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT source FROM entitlements
      WHERE user_id = ? AND product = 'plus' AND ${liveEntitlement(env)}
      ORDER BY source`,
  )
    .bind(userId)
    .all<{ source: PlusSource }>();
  return (results ?? []).map((r) => r.source);
}

/** Whether this user has Plus from any source. */
export async function hasPlus(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS one FROM entitlements
      WHERE user_id = ? AND product = 'plus' AND ${liveEntitlement(env)} LIMIT 1`,
  )
    .bind(userId)
    .first<{ one: number }>();
  return !!row;
}

export function getArtwork(env: Env, id: string): Promise<Artwork | null> {
  return env.DB.prepare("SELECT * FROM artworks WHERE id = ?").bind(id).first<Artwork>();
}

/** Set an artwork's alt text. Idempotent per-row; used by the save-time AI
 *  upgrade and the admin backfill. */
export async function setArtworkAlt(env: Env, id: string, alt: string): Promise<void> {
  await env.DB.prepare("UPDATE artworks SET alt_text = ? WHERE id = ?").bind(alt, id).run();
}

/** Rows still missing alt text (legacy pre-migration artworks), for backfill. */
export async function listArtworksMissingAlt(env: Env, limit: number): Promise<Artwork[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM artworks WHERE alt_text IS NULL ORDER BY created_at DESC LIMIT ?",
  )
    .bind(limit)
    .all<Artwork>();
  return results ?? [];
}

export interface ArtworkWithAuthor extends Artwork {
  author_name: string | null;
  author_avatar: string | null;
}

export function getArtworkWithAuthor(env: Env, id: string): Promise<ArtworkWithAuthor | null> {
  return env.DB.prepare(
    `SELECT a.*, u.name AS author_name, u.avatar_url AS author_avatar
     FROM artworks a JOIN users u ON u.id = a.user_id WHERE a.id = ?`,
  )
    .bind(id)
    .first<ArtworkWithAuthor>();
}

export interface Page {
  cursor: string | null;
  limit: number;
}

function decodeCursor(cursor: string | null): { ts: number; id: string } | null {
  if (!cursor) return null;
  const i = cursor.lastIndexOf(":");
  if (i < 0) return null;
  const ts = parseInt(cursor.slice(0, i), 10);
  const id = cursor.slice(i + 1);
  if (Number.isNaN(ts) || !id) return null;
  return { ts, id };
}

export function encodeCursor(a: { created_at: number; id: string }): string {
  return `${a.created_at}:${a.id}`;
}

export async function listPublic(env: Env, page: Page): Promise<ArtworkWithAuthor[]> {
  const c = decodeCursor(page.cursor);
  const sql = c
    ? `SELECT a.*, u.name AS author_name, u.avatar_url AS author_avatar
       FROM artworks a JOIN users u ON u.id = a.user_id
       WHERE a.visibility = 'public' AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))
       ORDER BY a.created_at DESC, a.id DESC LIMIT ?`
    : `SELECT a.*, u.name AS author_name, u.avatar_url AS author_avatar
       FROM artworks a JOIN users u ON u.id = a.user_id
       WHERE a.visibility = 'public'
       ORDER BY a.created_at DESC, a.id DESC LIMIT ?`;
  const stmt = c
    ? env.DB.prepare(sql).bind(c.ts, c.ts, c.id, page.limit)
    : env.DB.prepare(sql).bind(page.limit);
  const { results } = await stmt.all<ArtworkWithAuthor>();
  return results ?? [];
}

// A random sample of public artworks (with author), for the iOS widget's batch fetch.
// TODO: ORDER BY RANDOM() is fine at this scale; switch to a random-offset strategy if the
// artworks table ever gets huge.
export async function randomPublic(env: Env, limit: number): Promise<ArtworkWithAuthor[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.*, u.name AS author_name, u.avatar_url AS author_avatar
     FROM artworks a JOIN users u ON u.id = a.user_id
     WHERE a.visibility = 'public'
     ORDER BY RANDOM() LIMIT ?`,
  )
    .bind(limit)
    .all<ArtworkWithAuthor>();
  return results ?? [];
}

export async function listByUser(env: Env, userId: string, page: Page): Promise<Artwork[]> {
  const c = decodeCursor(page.cursor);
  const sql = c
    ? `SELECT * FROM artworks WHERE user_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`
    : `SELECT * FROM artworks WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`;
  const stmt = c
    ? env.DB.prepare(sql).bind(userId, c.ts, c.ts, c.id, page.limit)
    : env.DB.prepare(sql).bind(userId, page.limit);
  const { results } = await stmt.all<Artwork>();
  return results ?? [];
}

/**
 * Apply a title / visibility edit and stamp `updated_at`.
 *
 * A move to `public` NEVER comes through here — that goes through
 * `publishArtwork`, which carries the cap predicate. Moving to private or
 * unlisted deliberately leaves `published_at` alone: it records when a piece
 * first went public, which stays true after it comes back down, and clearing it
 * would let a user launder past the cap by unpublishing and republishing.
 */
export async function updateArtwork(
  env: Env,
  id: string,
  patch: { title?: string; visibility?: Exclude<Visibility, "public">; updated_at?: number },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    vals.push(patch.title);
  }
  if (patch.visibility !== undefined) {
    sets.push("visibility = ?");
    vals.push(patch.visibility);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  vals.push(patch.updated_at ?? Date.now());
  vals.push(id);
  await env.DB.prepare(`UPDATE artworks SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
}

export async function deleteArtworkRow(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM artworks WHERE id = ?").bind(id).run();
}

export async function incrementLikes(env: Env, id: string): Promise<number> {
  await env.DB.prepare("UPDATE artworks SET likes = likes + 1 WHERE id = ?").bind(id).run();
  const row = await env.DB.prepare("SELECT likes FROM artworks WHERE id = ?").bind(id).first<{ likes: number }>();
  return row?.likes ?? 0;
}

export async function listPublicIds(env: Env, limit = 1000): Promise<{ id: string; created_at: number }[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, created_at FROM artworks WHERE visibility = 'public' ORDER BY created_at DESC LIMIT ?",
  )
    .bind(limit)
    .all<{ id: string; created_at: number }>();
  return results ?? [];
}

export async function setUserAdminFlag(
  env: Env,
  google_sub: string,
  patch: { role?: string; flagged?: number },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.role !== undefined) {
    sets.push("role = ?");
    vals.push(patch.role);
  }
  if (patch.flagged !== undefined) {
    sets.push("flagged = ?");
    vals.push(patch.flagged);
  }
  if (sets.length === 0) return;
  vals.push(google_sub);
  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE google_sub = ?`).bind(...vals).run();
}
