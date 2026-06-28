// ID + token helpers built on Web Crypto (available in workerd).

import { customAlphabet } from "nanoid";

// URL-safe, unambiguous alphabet for permalinks.
const artworkAlphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const artworkId = customAlphabet(artworkAlphabet, 12);

export function newArtworkId(): string {
  return artworkId();
}

export function newUserId(): string {
  return crypto.randomUUID();
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Cryptographically random url-safe token (default 256-bit). */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}
