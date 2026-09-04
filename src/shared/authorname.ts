/**
 * The name shown beside somebody else's drawing.
 *
 * Only the first name. A public wall is a public wall: "Anmol Saxena" under a
 * doodle is more of a person's identity than posting a picture asks for, and
 * once it is on an OG card it is indexable. Reported as "public gallery posts
 * should only include first name, last name feels like too much to just throw
 * up."
 *
 * Applied in the WORKER, at every point an author is serialized, so the surname
 * never leaves the server for public content — rather than in each client,
 * where it would still be in the JSON and would have to be re-fixed for every
 * new surface (the OG description already had the same problem).
 *
 * Your OWN name is untouched: the You tab reads `/api/me`, which is your
 * session, not an author field.
 *
 * Limits, stated because the fix is a heuristic and not a fact:
 *  - We store one `name` string from the identity provider, so "first" means
 *    the first whitespace-separated token. For a locale that puts the family
 *    name first, that token is the family name.
 *  - A single-token name is returned whole, which is correct for mononyms.
 */
export function publicAuthorName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Split on any whitespace run, not just " " — provider names arrive with
  // non-breaking and ideographic spaces often enough to matter.
  const first = trimmed.split(/\s+/u)[0]!;
  return first.length > 0 ? first : null;
}
