"""Bridge from the play store into the existing pipeline.

``pipeline/build.py`` consumes ``(AlbumGroup list, stats)`` from
``pipeline.scrobbles.load_groups``, which reads the CSV. Nothing here modifies
that. Instead there are two ways in:

* :func:`load_groups_from_store` builds the identical ``AlbumGroup`` objects
  from play events, so any future caller can skip the CSV entirely.
* :func:`export_csv` writes the store back out in Last.fm export shape, so the
  *current* ``python -m pipeline.build --csv ...`` works against merged
  multi-source history today, with no pipeline changes at all.

This is also the one place the ``ms_played`` unlock rule is applied. Events are
stored raw; a play only becomes a "track played" here, where the threshold can
be changed and the whole collection rebuilt without re-importing anything.
"""

from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path

from pipeline.scrobbles import AlbumGroup, PlayedTrack
from pipeline.normalize import clean_artist, clean_title

from .schema import DEFAULT_MIN_MS_PLAYED


def load_groups_from_events(events, *, min_ms: int = DEFAULT_MIN_MS_PLAYED
                            ) -> tuple[list[AlbumGroup], dict]:
    """Fold play events into album candidate groups.

    Mirrors ``pipeline.scrobbles.load_groups`` exactly — same grouping keys,
    same ordering, same stats keys — so the two are interchangeable downstream.
    """
    groups: dict[str, AlbumGroup] = {}
    artists: set[str] = set()
    total = 0
    first_uts = None
    last_uts = None
    skipped_no_album = 0
    skipped_short = 0

    for ev in events:
        if not ev.counts_as_listen(min_ms):
            skipped_short += 1
            continue

        total += 1
        artists.add(ev.artist_key)
        first_uts = ev.ts if first_uts is None else min(first_uts, ev.ts)
        last_uts = ev.ts if last_uts is None else max(last_uts, ev.ts)

        if not ev.album:
            skipped_no_album += 1
            continue

        ak, alk = ev.artist_key, ev.album_key
        gid = f"{ak}||{alk}"
        g = groups.get(gid)
        if g is None:
            g = groups[gid] = AlbumGroup(
                artist_key=ak, album_key=alk,
                artist=clean_artist(ev.artist), album=clean_title(ev.album),
                first_uts=ev.ts, last_uts=ev.ts,
            )
        g.play_count += 1
        g.first_uts = min(g.first_uts, ev.ts)
        g.last_uts = max(g.last_uts, ev.ts)
        g._artist_names[clean_artist(ev.artist)] += 1
        g._album_names[clean_title(ev.album)] += 1
        if ev.album_mbid:
            g.album_mbids[ev.album_mbid] += 1
        if ev.artist_mbid:
            g.artist_mbids[ev.artist_mbid] += 1

        tk = ev.track_key
        t = g.tracks.get(tk)
        if t is None:
            t = g.tracks[tk] = PlayedTrack(key=tk, display=clean_title(ev.track),
                                           first_uts=ev.ts)
        t.play_count += 1
        t.first_uts = min(t.first_uts, ev.ts)
        if ev.track_mbid:
            t.track_mbids[ev.track_mbid] += 1

    for g in groups.values():
        if g._artist_names:
            g.artist = g._artist_names.most_common(1)[0][0]
        if g._album_names:
            g.album = g._album_names.most_common(1)[0][0]

    ordered = sorted(groups.values(),
                     key=lambda g: (-g.distinct_tracks, -g.play_count, g.artist_key))
    stats = {
        "total_plays": total,
        "distinct_artists": len(artists),
        "first_play": _iso(first_uts or 0),
        "last_play": _iso(last_uts or 0),
        "group_count": len(ordered),
        "rows_without_album": skipped_no_album,
        "skipped_below_threshold": skipped_short,
    }
    return ordered, stats


def load_groups_from_store(store, *, min_ms: int = DEFAULT_MIN_MS_PLAYED):
    return load_groups_from_events(store.events, min_ms=min_ms)


def export_csv(events, path, *, min_ms: int = DEFAULT_MIN_MS_PLAYED) -> int:
    """Write play events in the Last.fm export CSV shape.

    The point is compatibility, not fidelity: this is what lets the unmodified
    ``pipeline.build`` see Spotify and live-Last.fm plays. Sub-threshold plays
    are dropped here because the CSV has nowhere to record ``ms_played``, so a
    consumer of the CSV could not apply the rule itself.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    rows = sorted((e for e in events if e.counts_as_listen(min_ms)),
                  key=lambda e: -e.ts)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, quoting=csv.QUOTE_ALL)
        w.writerow(["uts", "utc_time", "artist", "artist_mbid", "album",
                    "album_mbid", "track", "track_mbid"])
        for ev in rows:
            w.writerow([
                ev.ts,
                datetime.fromtimestamp(ev.ts, tz=timezone.utc).strftime("%d %b %Y, %H:%M"),
                ev.artist, ev.artist_mbid or "",
                ev.album or "", ev.album_mbid or "",
                ev.track, ev.track_mbid or "",
            ])
            written += 1
    return written


def _iso(uts: int) -> str:
    return datetime.fromtimestamp(int(uts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
