"""Title / artist normalization.

This module is deliberately standalone and heavily tested: it is the part of the
pipeline most likely to be subtly wrong, and a wrong normalizer produces either
false unlocks (two different tracks folded into one) or false misses (the same
track written two ways).

Three levels of aggression:

* ``clean_title``  -- removes edition/remaster noise, keeps human readability.
* ``title_key``    -- clean_title + casefold + punctuation/article stripping.
                      Used to match a played track against a canonical tracklist.
* ``artist_key``   -- folds artist-name variants ("The Nat King Cole Trio" ->
                      "nat king cole").
"""

from __future__ import annotations

import re
import unicodedata

# --------------------------------------------------------------------------
# Noise vocabulary
# --------------------------------------------------------------------------

# Words that mark a trailing parenthetical / dash-suffix as packaging metadata
# rather than part of the work's identity.
_NOISE_WORDS = r"""
    remaster(?:ed|s)? | remastering
  | deluxe | expanded | extended\s+edition
  | (?:\d{2,4}(?:st|nd|rd|th)?\s+)?anniversary
  | bonus\s+track(?:s)? | bonus\s+version | bonus\s+edition
  | reissue | re-?issue
  | explicit | clean
  | mono | stereo | mono\s+version | stereo\s+version
  | digital\s+remaster(?:ed)? | digitally\s+remastered
  | original\s+recording\s+remastered
  | album\s+version | single\s+version | original\s+version
  | (?:deluxe|bonus\s*track(?:s)?|expanded|special|standard|international
     |japanese|explicit|clean|remastered)\s+version
  | standard\s+edition | special\s+edition | legacy\s+edition
  | collector'?s\s+edition | super\s+deluxe(?:\s+edition)?
  | international\s+version | japanese\s+edition | uk\s+version | us\s+version
  | .*?\bedition\b
  | remaster(?:ed)?\s+version
"""

_NOISE_RE = re.compile(
    r"^\s*(?:\d{4}\s+)?(?:%s)(?:\s+\d{4})?\s*$" % _NOISE_WORDS, re.I | re.X
)

# "feat." style credits appended to a track title.
_FEAT_RE = re.compile(
    r"""[\(\[]\s*(?:feat|ft|featuring|with)\.?\s[^)\]]*[\)\]]|  # (feat. X)
        \s[-–—]\s(?:feat|ft|featuring)\.?\s.*$|                 # - feat. X
        \s(?:feat|ft)\.\s.*$                                    # feat. X
    """,
    re.I | re.X,
)

_BRACKET_RE = re.compile(r"\s*[\(\[]([^()\[\]]*)[\)\]]\s*$")

# Trailing " - <noise>" suffix. Handles en/em dashes too.
_DASH_SPLIT_RE = re.compile(r"\s[-–—]\s")

_ARTICLE_RE = re.compile(r"^(the|a|an)\s+", re.I)
_ENSEMBLE_RE = re.compile(
    r"\s+(trio|quartet|quintet|sextet|septet|octet|band|orchestra|ensemble|"
    r"group|combo|experience|project|collective)$",
    re.I,
)
_ARTIST_SPLIT_RE = re.compile(r"\s*(?:,|&|\band\b|\bwith\b|\bfeat\.?\b|\bft\.?\b|\bx\b|;|/)\s*", re.I)

_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WS_RE = re.compile(r"\s+")


def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def _is_noise(fragment: str) -> bool:
    frag = fragment.strip().strip("-–—").strip()
    if not frag:
        return False
    return bool(_NOISE_RE.match(frag))


def clean_title(raw: str) -> str:
    """Strip edition/remaster packaging noise while keeping the title readable.

    >>> clean_title("She's Electric - Remastered")
    "She's Electric"
    >>> clean_title("(What's The Story) Morning Glory? (Deluxe Remastered Edition)")
    "(What's The Story) Morning Glory?"
    """
    if raw is None:
        return ""
    s = unicodedata.normalize("NFKC", str(raw)).strip()
    s = s.replace("’", "'").replace("‘", "'")
    s = _FEAT_RE.sub("", s).strip()

    # Repeatedly peel trailing bracketed noise: "Album (Deluxe) (Remastered)".
    changed = True
    while changed:
        changed = False
        m = _BRACKET_RE.search(s)
        if m and _is_noise(m.group(1)):
            s = s[: m.start()].strip()
            changed = True

    # Peel trailing " - <noise>" segments (right to left).
    while True:
        seps = list(_DASH_SPLIT_RE.finditer(s))
        if not seps:
            break
        last = seps[-1]
        if _is_noise(s[last.end():]):
            s = s[: last.start()].strip()
            continue
        break

    # A trailing bracket may now be exposed again.
    m = _BRACKET_RE.search(s)
    if m and _is_noise(m.group(1)):
        s = s[: m.start()].strip()

    return _WS_RE.sub(" ", s).strip(" -–—") or str(raw).strip()


def title_key(raw: str) -> str:
    """Aggressive match key for track/album titles.

    Case-, accent- and punctuation-insensitive; leading article dropped.
    """
    s = clean_title(raw)
    s = _strip_accents(s).casefold()
    s = s.replace("&", " and ")
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    s = _ARTICLE_RE.sub("", s)
    return s.strip()


def clean_artist(raw: str) -> str:
    """Human-readable artist name with credits stripped."""
    if raw is None:
        return ""
    s = unicodedata.normalize("NFKC", str(raw)).strip()
    s = s.replace("’", "'")
    s = _FEAT_RE.sub("", s).strip()
    return _WS_RE.sub(" ", s)


def artist_key(raw: str) -> str:
    """Fold artist-name variants onto a single key.

    Drops a leading article, a trailing ensemble noun and any secondary credited
    artists, so "The Nat King Cole Trio" and "Nat King Cole" agree.
    """
    s = clean_artist(raw)
    s = _strip_accents(s).casefold()
    s = s.replace("&", " and ")
    # Primary credit only.
    primary = _ARTIST_SPLIT_RE.split(s)[0] if s else s
    if primary.strip():
        s = primary
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    s = _ARTICLE_RE.sub("", s).strip()
    prev = None
    while prev != s:
        prev = s
        s = _ENSEMBLE_RE.sub("", s).strip()
    return s or _PUNCT_RE.sub(" ", _strip_accents(clean_artist(raw)).casefold()).strip()


def group_key(artist: str, album: str) -> tuple[str, str]:
    """The identity used to group scrobble rows into album candidates."""
    return (artist_key(artist), title_key(album))


def slugify(*parts: str) -> str:
    s = "-".join(p for p in parts if p)
    s = _strip_accents(s).casefold()
    s = re.sub(r"[^\w]+", "-", s)
    return s.strip("-")[:120] or "unknown"
