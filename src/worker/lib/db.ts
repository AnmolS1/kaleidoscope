// D1 data access for users + artworks. Keyset pagination on (created_at, id).

import type { Env, User, Artwork, Visibility } from "../types";
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
}

export async function insertArtwork(env: Env, a: NewArtwork): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO artworks
      (id, user_id, title, visibility, image_key, thumb_key, vector_key, width, height, segments, mirror, palette, remix_of, likes, created_at, alt_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      a.id, a.user_id, a.title, a.visibility, a.image_key, a.thumb_key, a.vector_key,
      a.width, a.height, a.segments, a.mirror, a.palette, a.remix_of, a.created_at, a.alt_text,
    )
    .run();
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

export async function updateArtwork(
  env: Env,
  id: string,
  patch: { title?: string; visibility?: Visibility },
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
