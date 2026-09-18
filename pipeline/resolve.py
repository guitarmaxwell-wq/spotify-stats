"""Resolve an AlbumGroup to a MusicBrainz release + canonical tracklist."""

from __future__ import annotations

from dataclasses import dataclass

from .musicbrainz import MusicBrainzClient
from .normalize import artist_key, title_key
from .scrobbles import AlbumGroup


@dataclass
class Resolution:
    release: dict | None = None
    source: str = "unresolved"  # musicbrainz_mbid | musicbrainz_search | unresolved
    reason: str | None = None
    tracklist: list[str] | None = None


def tracklist_of(release: dict | None) -> list[str]:
    """Flatten every medium's tracks into an ordered title list.

    Data tracks (CD-ROM extras) are skipped; they are not listenable.
    """
    if not release:
        return []
    titles: list[str] = []
    for medium in release.get("media") or []:
        for track in medium.get("tracks") or []:
            if track.get("data-track"):
                continue
            title = (track.get("title") or "").strip()
            if not title:
                rec = track.get("recording") or {}
                title = (rec.get("title") or "").strip()
            if title:
                titles.append(title)
    return titles


def _credit_name(release: dict) -> str:
    return "".join(
        (c.get("name") or c.get("artist", {}).get("name") or "") + (c.get("joinphrase") or "")
        for c in release.get("artist-credit") or []
    ).strip()


def _score_candidate(group: AlbumGroup, cand: dict) -> float:
    score = float(cand.get("score", 0)) / 100.0
    if title_key(cand.get("title", "")) == group.album_key:
        score += 2.0
    cand_artist = _credit_name(cand)
    if cand_artist and artist_key(cand_artist) == group.artist_key:
        score += 2.0
    tc = cand.get("track-count") or 0
    if tc:
        if tc >= group.distinct_tracks:
            score += 0.75
        else:
            score -= 1.0
        # Prefer the tightest release that still covers what was played
        # (avoids box sets swallowing a single album).
        score -= min(abs(tc - group.distinct_tracks), 40) / 100.0
    if (cand.get("status") or "").lower() == "official":
        score += 0.3
    return score


def resolve_group(group: AlbumGroup, mb: MusicBrainzClient) -> Resolution:
    # Path 1: trust the album_mbid carried by the scrobbles.
    mbid = group.best_album_mbid()
    if mbid:
        rel = mb.release(mbid)
        if rel and tracklist_of(rel):
            return Resolution(rel, "musicbrainz_mbid", None, tracklist_of(rel))

    # Path 2: search by artist + album.
    cands = mb.search_release(group.artist, group.album)
    if not cands:
        cands = mb.search_release_loose(group.artist, group.album)
    if not cands:
        return Resolution(None, "unresolved", "no_mb_match")

    ranked = sorted(cands, key=lambda c: -_score_candidate(group, c))
    for cand in ranked[:2]:
        if _score_candidate(group, cand) < 1.0:
            break
        rel = mb.release(cand["id"])
        tl = tracklist_of(rel)
        if tl:
            return Resolution(rel, "musicbrainz_search", None, tl)
    return Resolution(None, "unresolved", "no_tracklist")
