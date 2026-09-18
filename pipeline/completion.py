"""Match played tracks against a canonical tracklist and score completion.

Matching is deliberately conservative and *one-to-one*: a single played track can
satisfy at most one canonical track. Without that constraint a fuzzy match on a
noisy title ("Intro" vs "Intro (Skit)") could satisfy two slots and manufacture a
false unlock.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher

from .normalize import title_key

FUZZY_THRESHOLD = 0.90

# Words that, appended to an otherwise identical title, usually describe the
# same slot on the tracklist rather than a different work.
VARIANT_WORDS = {
    "instrumental", "instrumentals", "remaster", "remastered", "mono", "stereo",
    "version", "edit", "mix", "reprise", "interlude", "skit", "outro", "intro",
    "acappella", "acapella", "vocal", "radio", "album", "single", "original",
    "take", "alt", "alternate",
}


@dataclass
class Match:
    position: int
    canonical_title: str
    canonical_key: str
    played_key: str | None = None
    score: float = 0.0
    method: str = "none"

    @property
    def matched(self) -> bool:
        return self.played_key is not None


def _squash(key: str) -> str:
    return key.replace(" ", "")


def _pair_score(ck: str, pk: str) -> tuple[float, str]:
    if not ck or not pk:
        return 0.0, "none"
    if ck == pk:
        return 1.0, "exact"
    if _squash(ck) == _squash(pk):
        return 0.99, "squashed"
    longer, shorter = (ck, pk) if len(ck) >= len(pk) else (pk, ck)
    if longer.startswith(shorter + " "):
        tail = set(longer[len(shorter) + 1:].split())
        if tail and tail <= VARIANT_WORDS:
            # "Jay Dee 1" vs "Jay Dee 1 - Instrumental". Exact matches are
            # assigned first, so an album that carries both the vocal and the
            # instrumental keeps them in separate slots.
            return 0.93, "variant"
        if len(shorter) / len(longer) >= 0.7:
            return 0.95, "prefix"
    ratio = SequenceMatcher(None, ck, pk).ratio()
    if ratio >= FUZZY_THRESHOLD:
        return ratio, "fuzzy"
    return 0.0, "none"


def build_matching(canonical_titles: list[str], played_keys) -> list[Match]:
    """Greedy best-first one-to-one matching of played keys to canonical tracks."""
    matches = [
        Match(position=i + 1, canonical_title=t, canonical_key=title_key(t))
        for i, t in enumerate(canonical_titles)
    ]
    played = list(dict.fromkeys(played_keys))

    candidates = []
    for mi, m in enumerate(matches):
        for pk in played:
            score, method = _pair_score(m.canonical_key, pk)
            if score > 0:
                candidates.append((score, method, mi, pk))
    # Highest score first; ties broken deterministically by tracklist position.
    candidates.sort(key=lambda c: (-c[0], c[2], c[3]))

    used_played: set[str] = set()
    for score, method, mi, pk in candidates:
        if matches[mi].matched or pk in used_played:
            continue
        matches[mi].played_key = pk
        matches[mi].score = score
        matches[mi].method = method
        used_played.add(pk)
    return matches


def summarize(matches: list[Match], first_uts_by_key: dict[str, int] | None = None) -> dict:
    """Completion stats for one album.

    ``unlocked`` requires every canonical track to have at least one play.
    ``unlocked_uts`` is the timestamp of the play that completed the album, i.e.
    the latest of the per-track first plays.
    """
    total = len(matches)
    matched = [m for m in matches if m.matched]
    missing = [m.canonical_title for m in matches if not m.matched]
    unlocked = total > 0 and not missing

    unlocked_uts = None
    if unlocked and first_uts_by_key:
        stamps = [first_uts_by_key.get(m.played_key) for m in matched]
        stamps = [s for s in stamps if s]
        unlocked_uts = max(stamps) if len(stamps) == total else None

    return {
        "total_tracks": total,
        "played_tracks": len(matched),
        "completion": round(len(matched) / total, 4) if total else 0.0,
        "unlocked": unlocked,
        "unlocked_uts": unlocked_uts,
        "missing_tracks": missing,
        "fuzzy_matches": sum(1 for m in matched if m.method in ("fuzzy", "prefix")),
    }
