"""Load data/scrobbles.csv and fold it into album candidate groups."""

from __future__ import annotations

import csv
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .normalize import artist_key, clean_artist, clean_title, title_key


@dataclass
class PlayedTrack:
    """One distinct track (by normalized key) inside an album group."""

    key: str
    display: str
    play_count: int = 0
    first_uts: int = 0
    track_mbids: Counter = field(default_factory=Counter)


@dataclass
class AlbumGroup:
    artist_key: str
    album_key: str
    artist: str  # most common raw spelling
    album: str  # most common raw spelling
    play_count: int = 0
    first_uts: int = 0
    last_uts: int = 0
    album_mbids: Counter = field(default_factory=Counter)
    artist_mbids: Counter = field(default_factory=Counter)
    tracks: dict[str, PlayedTrack] = field(default_factory=dict)
    _artist_names: Counter = field(default_factory=Counter)
    _album_names: Counter = field(default_factory=Counter)

    @property
    def distinct_tracks(self) -> int:
        return len(self.tracks)

    @property
    def gid(self) -> str:
        return f"{self.artist_key}||{self.album_key}"

    def best_album_mbid(self) -> str | None:
        return self.album_mbids.most_common(1)[0][0] if self.album_mbids else None

    def best_artist_mbid(self) -> str | None:
        return self.artist_mbids.most_common(1)[0][0] if self.artist_mbids else None


def iso(uts: int) -> str:
    return datetime.fromtimestamp(int(uts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_groups(csv_path: str | Path) -> tuple[list[AlbumGroup], dict]:
    """Return (groups sorted by distinct track count desc, global stats)."""
    groups: dict[str, AlbumGroup] = {}
    artists: set[str] = set()
    total = 0
    first_uts = None
    last_uts = None
    skipped_no_album = 0

    with open(csv_path, "r", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            raw_artist = (row.get("artist") or "").strip()
            raw_album = (row.get("album") or "").strip()
            raw_track = (row.get("track") or "").strip()
            try:
                uts = int(row.get("uts") or 0)
            except ValueError:
                uts = 0
            if not raw_artist or not raw_track:
                continue
            total += 1
            artists.add(artist_key(raw_artist))
            first_uts = uts if first_uts is None else min(first_uts, uts)
            last_uts = uts if last_uts is None else max(last_uts, uts)

            if not raw_album:
                skipped_no_album += 1
                continue

            ak, alk = artist_key(raw_artist), title_key(raw_album)
            gid = f"{ak}||{alk}"
            g = groups.get(gid)
            if g is None:
                g = groups[gid] = AlbumGroup(
                    artist_key=ak,
                    album_key=alk,
                    artist=clean_artist(raw_artist),
                    album=clean_title(raw_album),
                    first_uts=uts,
                    last_uts=uts,
                )
            g.play_count += 1
            g.first_uts = min(g.first_uts, uts)
            g.last_uts = max(g.last_uts, uts)
            g._artist_names[clean_artist(raw_artist)] += 1
            g._album_names[clean_title(raw_album)] += 1
            if row.get("album_mbid"):
                g.album_mbids[row["album_mbid"].strip()] += 1
            if row.get("artist_mbid"):
                g.artist_mbids[row["artist_mbid"].strip()] += 1

            tk = title_key(raw_track)
            t = g.tracks.get(tk)
            if t is None:
                t = g.tracks[tk] = PlayedTrack(key=tk, display=clean_title(raw_track), first_uts=uts)
            t.play_count += 1
            t.first_uts = min(t.first_uts, uts)
            if row.get("track_mbid"):
                t.track_mbids[row["track_mbid"].strip()] += 1

    for g in groups.values():
        if g._artist_names:
            g.artist = g._artist_names.most_common(1)[0][0]
        if g._album_names:
            g.album = g._album_names.most_common(1)[0][0]

    ordered = sorted(
        groups.values(), key=lambda g: (-g.distinct_tracks, -g.play_count, g.artist_key)
    )
    stats = {
        "total_plays": total,
        "distinct_artists": len(artists),
        "first_play": iso(first_uts or 0),
        "last_play": iso(last_uts or 0),
        "group_count": len(ordered),
        "rows_without_album": skipped_no_album,
    }
    return ordered, stats
