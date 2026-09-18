"""The common play-event schema.

Every source normalizes into :class:`PlayEvent`. Nothing downstream should know
or care whether a play arrived from Last.fm, a Spotify poll or a GDPR export —
except through the fields that genuinely differ (``ms_played`` is present only
for the Spotify export, and nothing else should be inferred from its absence).

Two deliberate decisions are encoded here.

**Timestamp semantics differ by source and we record which we got.** Last.fm's
``uts`` is when the track *started*; Spotify's ``played_at`` and the export's
``ts`` are when the track *stopped*. That is a whole track-length of skew
between two records of the same play, which matters when de-duplicating a user
who has both Spotify and Last.fm linked. We do not try to correct it — we would
have to guess a duration we often do not have — we record ``ts_kind`` and let
:mod:`ingest.store` widen its dedupe window accordingly.

**``ms_played`` is stored, not applied.** Whether a play counts toward unlocking
an album is a product rule that will change; see ``counts_as_listen`` and the
discussion in ``ingest/README.md``. Storing the raw value means the rule can be
re-decided later without re-importing anything.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

from pipeline.normalize import artist_key, clean_artist, clean_title, title_key

SCHEMA_VERSION = 1


class Source:
    """Identifiers for the sources that can produce a play event."""

    LASTFM = "lastfm"
    LASTFM_CSV = "lastfm_csv"
    SPOTIFY_RECENT = "spotify_recent"
    SPOTIFY_EXPORT = "spotify_export"

    ALL = (LASTFM, LASTFM_CSV, SPOTIFY_RECENT, SPOTIFY_EXPORT)

    #: Does this source's timestamp mark the start or the end of the play?
    TS_KIND = {
        LASTFM: "start",
        LASTFM_CSV: "start",
        SPOTIFY_RECENT: "end",
        SPOTIFY_EXPORT: "end",
    }

    #: Which sources can report how long the track was actually played for.
    HAS_MS_PLAYED = {SPOTIFY_EXPORT}


#: A play shorter than this is treated as a skip and does not count toward
#: unlocking an album. Only applies to sources that report ``ms_played``.
#: See ``ingest/README.md`` for why 30s and not 10s.
DEFAULT_MIN_MS_PLAYED = 30_000

#: ...unless the track is shorter than the threshold, in which case a play of
#: this fraction of it counts. Guards against 20-second interludes and skits
#: being permanently unlockable — Donuts alone has a dozen.
SHORT_TRACK_FRACTION = 0.5


class InvalidPlayEvent(ValueError):
    """A row that cannot be represented as a play event."""


_WS = re.compile(r"\s+")


def safe_key(normalized: str, raw: str) -> str:
    """A match key that is never empty for a non-empty name.

    The pipeline's normalizers strip punctuation, so a name made entirely of it
    collapses to "". That is not hypothetical: ``¥$`` (Kanye West & Ty Dolla
    $ign) and tracks titled ``?`` or ``...`` are real rows in the data. Dropping
    them loses every play of *Vultures 1*; folding them all onto one empty key
    merges unrelated artists. So we fall back to a lightly-folded raw string,
    which keeps them distinct from each other and from everything else.
    """
    if normalized:
        return normalized
    s = unicodedata.normalize("NFKC", raw or "").casefold().strip()
    return _WS.sub(" ", s)


@dataclass(frozen=True)
class PlayEvent:
    """One play of one track, from any source.

    ``ts`` is Unix seconds UTC. ``artist`` and ``track`` are required; every
    other field is best-effort, because at least one source omits each of them.
    """

    ts: int
    artist: str
    track: str
    source: str
    album: str | None = None
    ms_played: int | None = None
    duration_ms: int | None = None
    artist_mbid: str | None = None
    album_mbid: str | None = None
    track_mbid: str | None = None
    # Spotify track URI, when the source knows it. Not used for matching today;
    # it is the only stable id Spotify gives us and throwing it away would be
    # irreversible.
    foreign_id: str | None = None

    # ---------------------------------------------------------------- keys --

    @property
    def artist_key(self) -> str:
        return safe_key(artist_key(self.artist), self.artist)

    @property
    def track_key(self) -> str:
        return safe_key(title_key(self.track), self.track)

    @property
    def album_key(self) -> str:
        return safe_key(title_key(self.album), self.album) if self.album else ""

    @property
    def ts_kind(self) -> str:
        return Source.TS_KIND.get(self.source, "start")

    @property
    def identity(self) -> tuple[str, str]:
        """What makes two events 'the same play' apart from time."""
        return (self.artist_key, self.track_key)

    @property
    def utc_time(self) -> str:
        return datetime.fromtimestamp(self.ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # ------------------------------------------------------------- product --

    def counts_as_listen(self, min_ms: int = DEFAULT_MIN_MS_PLAYED) -> bool:
        """Does this play count toward unlocking its album?

        Sources with no ``ms_played`` (Last.fm, Spotify's poll) always count —
        Last.fm has already applied its own scrobble threshold upstream, and
        second-guessing it with no duration data would just invent a rule.
        """
        if self.ms_played is None:
            return True
        if self.ms_played >= min_ms:
            return True
        if self.duration_ms and self.duration_ms < min_ms:
            return self.ms_played >= self.duration_ms * SHORT_TRACK_FRACTION
        return False

    # --------------------------------------------------------- (de)serialize --

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, sort_keys=True)

    @classmethod
    def from_dict(cls, d: dict) -> "PlayEvent":
        return make_event(
            ts=d.get("ts"),
            artist=d.get("artist"),
            track=d.get("track"),
            source=d.get("source"),
            album=d.get("album"),
            ms_played=d.get("ms_played"),
            duration_ms=d.get("duration_ms"),
            artist_mbid=d.get("artist_mbid"),
            album_mbid=d.get("album_mbid"),
            track_mbid=d.get("track_mbid"),
            foreign_id=d.get("foreign_id"),
        )


def _clean_str(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _clean_int(v) -> int | None:
    if v is None or v == "":
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def make_event(
    *,
    ts,
    artist,
    track,
    source: str,
    album=None,
    ms_played=None,
    duration_ms=None,
    artist_mbid=None,
    album_mbid=None,
    track_mbid=None,
    foreign_id=None,
) -> PlayEvent:
    """Validate and construct a :class:`PlayEvent`.

    Raises :class:`InvalidPlayEvent` rather than returning a half-built event:
    a play with no artist or no timestamp cannot be grouped, ordered or
    de-duplicated, so silently keeping it only corrupts counts later.
    """
    if source not in Source.ALL:
        raise InvalidPlayEvent(f"unknown source {source!r}")

    ts_i = _clean_int(ts)
    if not ts_i:
        raise InvalidPlayEvent("missing or non-positive ts")

    raw_artist = _clean_str(artist)
    raw_track = _clean_str(track)
    if not raw_artist:
        raise InvalidPlayEvent("missing artist")
    if not raw_track:
        raise InvalidPlayEvent("missing track")

    # Normalized display forms, so the store holds one spelling per source
    # quirk rather than "Wonderwall - Remastered" and "Wonderwall" as two rows.
    ev = PlayEvent(
        ts=ts_i,
        artist=clean_artist(raw_artist),
        track=clean_title(raw_track),
        source=source,
        album=clean_title(_clean_str(album)) if _clean_str(album) else None,
        ms_played=_clean_int(ms_played),
        duration_ms=_clean_int(duration_ms),
        artist_mbid=_clean_str(artist_mbid),
        album_mbid=_clean_str(album_mbid),
        track_mbid=_clean_str(track_mbid),
        foreign_id=_clean_str(foreign_id),
    )
    if not ev.artist_key or not ev.track_key:
        # Only reachable if even the raw fallback is empty, i.e. the name was
        # nothing but whitespace or zero-width characters.
        raise InvalidPlayEvent("artist or track has no usable key")
    return ev


@dataclass
class IngestResult:
    """What one sync actually did. Every source returns this shape."""

    source: str
    fetched: int = 0
    added: int = 0
    duplicates: int = 0
    invalid: int = 0
    skipped: int = 0  # dropped on purpose (podcasts, sub-threshold plays)
    cursor: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    def merge(self, other: "IngestResult") -> "IngestResult":
        self.fetched += other.fetched
        self.added += other.added
        self.duplicates += other.duplicates
        self.invalid += other.invalid
        self.skipped += other.skipped
        self.cursor.update(other.cursor)
        self.warnings.extend(other.warnings)
        return self

    def summary(self) -> str:
        bits = [
            f"{self.source}: +{self.added} new",
            f"{self.fetched} fetched",
            f"{self.duplicates} dup",
        ]
        if self.invalid:
            bits.append(f"{self.invalid} invalid")
        if self.skipped:
            bits.append(f"{self.skipped} skipped")
        return ", ".join(bits)
