// The one definition of "this title is the reserved word", compiled by BOTH the
// Worker and the client.
//
// It lived in two places — `validateTitle` in the Worker and `titleIsInvalid` in
// the save dialog — and they agreed only by inspection. When the Worker learned
// about script lookalikes (REVIEW.md minor mA2) the client did not, so a title
// the dialog accepted came back a 400 the user could not explain.

/**
 * Fold the handful of characters that LOOK like the letters in "untitled".
 *
 * Used for the reserved-word check only, never for what gets stored. NFKC folds
 * fullwidth and compatibility forms but says nothing about a Cyrillic `е` or a
 * Turkish dotless `ı`, so "Untıtled" and "Untitlеd" sailed past a rule whose
 * whole job is to stop a piece being published as "Untitled" (REVIEW.md minor
 * mA2).
 *
 * Deliberately BOUNDED to the letters of that one word rather than a general
 * confusables table: a general fold would collapse titles users are entitled to
 * choose, and the rule it defends is "name your piece", not "no two titles may
 * resemble each other".
 */
const UNTITLED_LOOKALIKES: Record<string, string> = {
  "\u0131": "i", // ı  Latin small dotless i
  "\u0456": "i", // і  Cyrillic
  "\u03b9": "i", // ι  Greek iota
  "\u0269": "i", // ɩ
  "\u0435": "e", // е  Cyrillic
  "\u04bd": "e", // ҽ  Cyrillic
  "\u0501": "d", // ԁ  Cyrillic
  "\u03c4": "t", // τ  Greek tau
  "\u03c5": "u", // υ  Greek upsilon
};

export function foldLookalikes(s: string): string {
  let out = "";
  for (const ch of s) out += UNTITLED_LOOKALIKES[ch] ?? ch;
  return out;
}

/**
 * Is this title the reserved word "Untitled"?
 *
 * NFKC first (fullwidth and compatibility forms), then the lookalike fold, then
 * equality — never a substring test, because "Untitled Study No. 4" is a title
 * someone might genuinely mean.
 */
export function isReservedTitle(raw: string): boolean {
  return foldLookalikes(raw.normalize("NFKC").trim().toLowerCase()) === "untitled";
}
