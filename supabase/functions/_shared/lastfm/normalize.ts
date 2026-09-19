/**
 * Server-side port of `app/src/link/normalize.ts`: artistKey and what it needs.
 *
 * This MUST stay byte-for-byte equivalent to the app's version. The synthetic
 * artist key `name:<artistKey>` (docs/REWARDS.md section 9) is an identity:
 * if the server and the app disagree on it, rules targeting a name-keyed artist
 * silently miss. `normalize.test.ts` pins the parity cases.
 *
 * The only textual change from the app is that the combining-mark range is
 * written as `̀-ͯ` escapes instead of the literal (invisible)
 * combining characters. The code points are identical.
 */

/**
 * Suffixes that mean packaging, not identity. A conservative subset.
 *
 * Note the escaped hyphen: in `[([-–—]` the `-` is read as a RANGE from `[` to
 * `–`, which silently excludes the plain ASCII hyphen and leaves every
 * "Track - Remastered" suffix in place. The escape is load-bearing.
 */
const NOISE =
  /\s*[([\-–—]\s*((\d{4}\s+)?(remaster(ed)?|deluxe|expanded|reissue|explicit|clean|mono|stereo|bonus track|anniversary|special|standard|legacy)[^)\]]*)\s*[)\]]?\s*$/i;

const FEAT = /\s*[([]\s*(feat|ft|featuring|with)\.?\s[^)\]]*[)\]]\s*/gi;

/** Human-readable form: credits and packaging stripped, case preserved. */
export function cleanTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).normalize("NFKC").replace(/[’‘]/g, "'").trim();
  s = s.replace(FEAT, " ");
  // Peel repeated trailing noise: "Album (Deluxe) (Remastered)".
  for (let i = 0; i < 4; i++) {
    const next = s.replace(NOISE, "").trim();
    if (next === s || !next) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").replace(/[\s\-–—]+$/, "").trim() || String(raw).trim();
}

export function cleanArtist(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw).normalize("NFKC").replace(/[’‘]/g, "'").replace(FEAT, " ")
    .replace(/\s+/g, " ").trim();
}

/**
 * Match key. Mirrors `safe_key` in ingest/schema.py: a name made entirely of
 * punctuation (`¥$`, a track called `?`) must not collapse to the empty string,
 * or every such artist merges into one.
 */
export function matchKey(raw: string | null | undefined): string {
  if (!raw) return "";
  const cleaned = cleanTitle(raw);
  const folded = cleaned
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(the|a|an)\s+/, "");
  if (folded) return folded;
  return cleaned.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Artist key: primary credit only, so "Oasis & X" folds onto "Oasis". */
export function artistKey(raw: string | null | undefined): string {
  if (!raw) return "";
  const primary = cleanArtist(raw).split(/\s*(?:,|&|\band\b|\bwith\b|\bfeat\.?\b|\bft\.?\b|;|\/)\s*/i)[0];
  const key = matchKey(primary || raw);
  return key.replace(
    /\s+(trio|quartet|quintet|sextet|band|orchestra|ensemble|group|combo|experience|project|collective)$/,
    "",
  ).trim() || key;
}
