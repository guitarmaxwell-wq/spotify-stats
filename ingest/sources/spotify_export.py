"""Spotify Extended Streaming History (GDPR export) — the only real backfill.

This is the one path that can hand a new user a full shelf on day one from
Spotify data, and it is not an API. The user requests it at
spotify.com → Account → Privacy → "Extended streaming history", waits (officially
up to 30 days, in practice 1–5), and gets a zip of JSON files. Nothing about
that can be automated, so it is a power-user importer and never the onboarding.

It is, however, the *best* data we can get from anywhere, because it carries
``ms_played``. Last.fm scrobbles have no duration at all, so with a Last.fm-only
shelf a two-second accidental tap counts the same as a full listen.

Two export formats exist and users confuse them constantly:

* **Extended streaming history** — ``Streaming_History_Audio_2020-2021_0.json``,
  all-time, with ``ts`` / ``master_metadata_*`` / ``ms_played``. This is the one.
* **Account data** — ``StreamingHistory0.json``, *last 12 months only*, with
  ``endTime`` / ``artistName`` / ``trackName`` / ``msPlayed``.

We read both, and warn when we see the second one, because a user who waited
three weeks for the wrong zip deserves to be told rather than shown a thin shelf.
"""

from __future__ import annotations

import json
import zipfile
from datetime import datetime
from pathlib import Path

from ..schema import (
    DEFAULT_MIN_MS_PLAYED,
    InvalidPlayEvent,
    IngestResult,
    Source,
    make_event,
)
from ..store import PlayStore
from .base import SourceError, collect

#: Filenames inside the zip we care about.
EXTENDED_PREFIX = "Streaming_History_Audio"
ACCOUNT_PREFIX = "StreamingHistory"


def _parse_ts(value) -> int:
    if not value:
        raise InvalidPlayEvent("missing ts")
    s = str(value).strip().replace("Z", "+00:00")
    # The account-data format uses "2021-05-03 17:20" local-ish time with no
    # zone. Treating it as UTC is the documented reading and is what every
    # other tool does; the error is bounded by the user's offset.
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        try:
            dt = datetime.fromisoformat(s.replace(" ", "T") + "+00:00")
        except ValueError as exc:
            raise InvalidPlayEvent(f"unparseable ts {value!r}") from exc
    if dt.tzinfo is None:
        from datetime import timezone

        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def parse_row(row: dict):
    """One export row -> PlayEvent, or None if it is not a music play.

    Podcast and audiobook rows carry ``episode_name`` / ``audiobook_title`` and
    a null ``master_metadata_track_name``. They are real plays but they are not
    album tracks, so they are dropped rather than counted as invalid.
    """
    if not isinstance(row, dict):
        raise InvalidPlayEvent("not an object")

    # Extended format first.
    track = row.get("master_metadata_track_name")
    artist = row.get("master_metadata_album_artist_name")
    if track is not None or artist is not None:
        if not track or not artist:
            return None  # podcast / episode / unnamed local file
        return make_event(
            ts=_parse_ts(row.get("ts")),
            artist=artist,
            track=track,
            album=row.get("master_metadata_album_album_name"),
            source=Source.SPOTIFY_EXPORT,
            ms_played=row.get("ms_played"),
            foreign_id=row.get("spotify_track_uri"),
        )

    # Account-data format.
    if row.get("trackName") or row.get("artistName"):
        if not row.get("trackName") or not row.get("artistName"):
            return None
        return make_event(
            ts=_parse_ts(row.get("endTime")),
            artist=row.get("artistName"),
            track=row.get("trackName"),
            album=None,  # this format has no album field at all
            source=Source.SPOTIFY_EXPORT,
            ms_played=row.get("msPlayed"),
        )

    if row.get("episode_name") or row.get("audiobook_title"):
        return None
    raise InvalidPlayEvent("unrecognised export row shape")


def iter_json_blobs(path: Path):
    """Yield ``(name, parsed_json)`` for every history file at ``path``.

    Accepts the zip as downloaded, an unzipped directory, or a single JSON file
    — users do all three and there is no reason to make them care.
    """
    path = Path(path)
    if not path.exists():
        raise SourceError(f"no such file or directory: {path}")

    if path.is_file() and path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            for info in sorted(zf.infolist(), key=lambda i: i.filename):
                name = Path(info.filename).name
                if info.is_dir() or not name.lower().endswith(".json"):
                    continue
                if not name.startswith((EXTENDED_PREFIX, ACCOUNT_PREFIX)):
                    continue
                with zf.open(info) as fh:
                    yield name, json.loads(fh.read().decode("utf-8"))
        return

    if path.is_file():
        yield path.name, json.loads(path.read_text(encoding="utf-8"))
        return

    for f in sorted(path.rglob("*.json")):
        if f.name.startswith((EXTENDED_PREFIX, ACCOUNT_PREFIX)):
            yield f.name, json.loads(f.read_text(encoding="utf-8"))


class SpotifyExportSource:
    """Fold a downloaded Extended Streaming History export into the store.

    ``min_ms`` here is a *storage* filter and defaults to off. The unlock
    threshold lives in :meth:`ingest.schema.PlayEvent.counts_as_listen` and is
    applied when albums are built, so the rule can be changed later without
    asking the user to re-import a zip they waited a month for.
    """

    name = Source.SPOTIFY_EXPORT

    def __init__(self, path, *, min_ms: int = 0):
        self.path = Path(path)
        self.min_ms = min_ms

    def read(self) -> tuple[list, int, int, list[str]]:
        events, invalid, skipped, warnings = [], 0, 0, []
        files = 0
        saw_account_format = False

        for name, blob in iter_json_blobs(self.path):
            files += 1
            if name.startswith(ACCOUNT_PREFIX) and not name.startswith(EXTENDED_PREFIX):
                saw_account_format = True
            if not isinstance(blob, list):
                warnings.append(f"{name}: expected a JSON array, skipping")
                continue
            for row in blob:
                try:
                    ev = parse_row(row)
                except InvalidPlayEvent:
                    invalid += 1
                    continue
                if ev is None:
                    skipped += 1
                    continue
                if self.min_ms and (ev.ms_played or 0) < self.min_ms:
                    skipped += 1
                    continue
                events.append(ev)

        if not files:
            raise SourceError(
                f"no streaming-history JSON files found in {self.path}. Expected files named "
                f"{EXTENDED_PREFIX}_*.json (from the 'Extended streaming history' request)."
            )
        if saw_account_format:
            warnings.append(
                "this looks like the 'Account data' export, which only covers the last "
                "12 months. The full backfill needs the separate 'Extended streaming "
                "history' request from spotify.com → Account → Privacy."
            )
        return events, invalid, skipped, warnings

    def sync(self, store: PlayStore) -> IngestResult:
        events, invalid, skipped, warnings = self.read()
        # A backfill must not move a *forward-sync* cursor, and it has its own,
        # so advancing on the export's newest play is right: re-importing the
        # same zip is then a no-op beyond dedupe.
        result = collect(self.name, store, events, invalid=invalid, skipped=skipped,
                         warnings=warnings)
        result.cursor = store.cursor(self.name).to_dict()
        return result


def describe_threshold(min_ms: int = DEFAULT_MIN_MS_PLAYED) -> str:
    return (
        f"A play counts toward unlocking when ms_played >= {min_ms // 1000}s, or when the "
        f"track is shorter than that and at least half of it was played."
    )
