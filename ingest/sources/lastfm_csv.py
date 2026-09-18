"""The existing ``data/scrobbles.csv`` export, as one source among several.

``pipeline/scrobbles.py`` still reads this file directly and still works; this
module does not replace it and does not touch it. What it adds is a way to get
the same 136k rows into the shared play store so they sit alongside Spotify and
live Last.fm plays under one schema.

The CSV is a Last.fm export, so its rows are scrobbles: ``uts`` is the start of
the play and there is no duration.
"""

from __future__ import annotations

import csv
from pathlib import Path

from ..schema import InvalidPlayEvent, IngestResult, Source, make_event
from ..store import PlayStore
from .base import SourceError, collect

COLUMNS = ("uts", "artist", "album", "track")


class LastfmCsvSource:
    """Bulk-load a Last.fm CSV export.

    Roughly 700 API requests' worth of history in a couple of seconds, which is
    why it stays the fastest cold start even though the API can do the same job.
    """

    name = Source.LASTFM_CSV

    def __init__(self, path):
        self.path = Path(path)

    def read(self) -> tuple[list, int, int]:
        if not self.path.exists():
            raise SourceError(f"no such CSV: {self.path}")

        events, invalid, skipped = [], 0, 0
        with open(self.path, "r", encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh)
            missing = [c for c in COLUMNS if c not in (reader.fieldnames or [])]
            if missing:
                raise SourceError(
                    f"{self.path.name} is missing column(s) {', '.join(missing)}; "
                    f"expected a Last.fm export with {', '.join(COLUMNS)}"
                )
            for row in reader:
                try:
                    events.append(make_event(
                        ts=row.get("uts"),
                        artist=row.get("artist"),
                        track=row.get("track"),
                        album=row.get("album"),
                        source=Source.LASTFM_CSV,
                        artist_mbid=row.get("artist_mbid"),
                        album_mbid=row.get("album_mbid"),
                        track_mbid=row.get("track_mbid"),
                    ))
                except InvalidPlayEvent:
                    # Rows with no album still make valid events — an album-less
                    # play counts toward artist stats even though it can never
                    # unlock anything. Only a missing artist/track/ts is fatal.
                    invalid += 1
        return events, invalid, skipped

    def sync(self, store: PlayStore) -> IngestResult:
        events, invalid, skipped = self.read()
        result = collect(self.name, store, events, invalid=invalid, skipped=skipped)
        result.cursor = store.cursor(self.name).to_dict()
        return result
