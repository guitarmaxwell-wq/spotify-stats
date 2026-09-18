"""Structured album cache — SQLite, keyed by MusicBrainz release MBID.

Per `docs/CATALOG.md` this is **not** a mirror of MusicBrainz. It is a lazily
populated cache of the albums our users have actually touched: 1,000 people who
all played *Donuts* should cost one upstream lookup, not a thousand. An album
enters it the first time anyone plays it, and each row carries ``fetched_at``
so it can be refreshed on a TTL rather than never.

SQLite because it is in the standard library, needs no server, is a single file
that ships anywhere, and — unlike the sharded JSON blobs underneath it — can
actually answer questions like "how many cached albums still have no artwork".

This sits *on top of* the raw HTTP cache in ``pipeline/httpcache.py``; that
layer still absorbs reruns and negative answers. This layer is what the build
consults first, and what a server would query at request time.

Never store Spotify-derived fields here (CATALOG.md). Artwork is stored as a
URL plus our derived colours; the bytes stay in the blob cache and can always
be re-fetched or put behind a CDN.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .httpcache import CACHE_DIR

SCHEMA_VERSION = 1
DEFAULT_DB = CACHE_DIR / "albums.sqlite3"
DEFAULT_TTL_DAYS = 30  # CATALOG.md: "say 30 days"

SCHEMA = """
CREATE TABLE IF NOT EXISTS albums (
    mbid            TEXT PRIMARY KEY,
    artist          TEXT NOT NULL,
    title           TEXT NOT NULL,
    release_year    INTEGER,
    tracklist       TEXT NOT NULL DEFAULT '[]',  -- JSON array of canonical titles
    genre_tags      TEXT NOT NULL DEFAULT '[]',  -- JSON array of [tag, weight]
    genre_id        TEXT,
    artwork_url     TEXT,
    artwork_source  TEXT,                        -- coverartarchive | deezer | none
    color_primary   TEXT,
    color_secondary TEXT,
    color_strategy  TEXT,                        -- extracted | derived | fallback
    fetched_at      TEXT NOT NULL,               -- ISO-8601 UTC
    schema_version  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_albums_fetched_at ON albums(fetched_at);
CREATE INDEX IF NOT EXISTS idx_albums_artwork_source ON albums(artwork_source);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


@dataclass
class AlbumRecord:
    mbid: str
    artist: str = ""
    title: str = ""
    release_year: int | None = None
    tracklist: list[str] = field(default_factory=list)
    genre_tags: list = field(default_factory=list)
    genre_id: str | None = None
    artwork_url: str | None = None
    artwork_source: str | None = None
    color_primary: str | None = None
    color_secondary: str | None = None
    color_strategy: str | None = None
    fetched_at: str = ""

    @property
    def colors(self) -> dict | None:
        if self.color_primary and self.color_secondary:
            return {"primary": self.color_primary, "secondary": self.color_secondary}
        return None

    def is_stale(self, ttl_days: int = DEFAULT_TTL_DAYS, now: datetime | None = None) -> bool:
        if ttl_days <= 0:
            return False
        fetched = _parse(self.fetched_at)
        if fetched is None:
            return True
        now = now or datetime.now(timezone.utc)
        return now - fetched > timedelta(days=ttl_days)


class AlbumCache:
    """Open (and migrate) the album store. Use as a context manager or ``close()``."""

    def __init__(self, path: Path | str = DEFAULT_DB):
        self.path = Path(path)
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
        self.conn.commit()
        self.hits = 0
        self.misses = 0
        self.stale = 0

    # -- lifecycle --------------------------------------------------------
    def close(self) -> None:
        self.conn.commit()
        self.conn.close()

    def __enter__(self) -> "AlbumCache":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- reads ------------------------------------------------------------
    def get(self, mbid: str, ttl_days: int | None = DEFAULT_TTL_DAYS,
            now: datetime | None = None) -> AlbumRecord | None:
        """Return the cached record, or None when absent **or past its TTL**.

        ``ttl_days=None`` (or 0) disables the TTL and returns whatever is
        stored — used by ``--offline`` runs, which have no way to refresh.
        """
        row = self.conn.execute("SELECT * FROM albums WHERE mbid = ?", (mbid,)).fetchone()
        if row is None:
            self.misses += 1
            return None
        rec = _row_to_record(row)
        if ttl_days and rec.is_stale(ttl_days, now):
            self.stale += 1
            return None
        self.hits += 1
        return rec

    def peek(self, mbid: str) -> AlbumRecord | None:
        """Read ignoring the TTL (for ``--offline``, and for tests)."""
        row = self.conn.execute("SELECT * FROM albums WHERE mbid = ?", (mbid,)).fetchone()
        return _row_to_record(row) if row else None

    def stats(self) -> dict:
        cur = self.conn.execute(
            "SELECT COUNT(*) AS n,"
            " SUM(CASE WHEN artwork_url IS NOT NULL THEN 1 ELSE 0 END) AS with_art,"
            " SUM(CASE WHEN color_primary IS NOT NULL THEN 1 ELSE 0 END) AS with_colors"
            " FROM albums"
        ).fetchone()
        by_source = {
            r["artwork_source"] or "none": r["n"]
            for r in self.conn.execute(
                "SELECT artwork_source, COUNT(*) AS n FROM albums GROUP BY artwork_source"
            )
        }
        return {
            "albums": cur["n"] or 0,
            "with_artwork": cur["with_art"] or 0,
            "with_colors": cur["with_colors"] or 0,
            "by_source": by_source,
        }

    # -- writes -----------------------------------------------------------
    def put(self, rec: AlbumRecord) -> AlbumRecord:
        rec.fetched_at = rec.fetched_at or utcnow()
        self.conn.execute(
            """
            INSERT INTO albums (mbid, artist, title, release_year, tracklist, genre_tags,
                                genre_id, artwork_url, artwork_source, color_primary,
                                color_secondary, color_strategy, fetched_at, schema_version)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(mbid) DO UPDATE SET
                artist=excluded.artist, title=excluded.title,
                release_year=excluded.release_year, tracklist=excluded.tracklist,
                genre_tags=excluded.genre_tags, genre_id=excluded.genre_id,
                artwork_url=excluded.artwork_url, artwork_source=excluded.artwork_source,
                color_primary=excluded.color_primary,
                color_secondary=excluded.color_secondary,
                color_strategy=excluded.color_strategy,
                fetched_at=excluded.fetched_at, schema_version=excluded.schema_version
            """,
            (
                rec.mbid, rec.artist, rec.title, rec.release_year,
                json.dumps(rec.tracklist, ensure_ascii=False),
                json.dumps(rec.genre_tags, ensure_ascii=False),
                rec.genre_id, rec.artwork_url, rec.artwork_source,
                rec.color_primary, rec.color_secondary, rec.color_strategy,
                rec.fetched_at, SCHEMA_VERSION,
            ),
        )
        self.conn.commit()
        return rec


def _row_to_record(row: sqlite3.Row) -> AlbumRecord:
    return AlbumRecord(
        mbid=row["mbid"],
        artist=row["artist"],
        title=row["title"],
        release_year=row["release_year"],
        tracklist=json.loads(row["tracklist"] or "[]"),
        genre_tags=json.loads(row["genre_tags"] or "[]"),
        genre_id=row["genre_id"],
        artwork_url=row["artwork_url"],
        artwork_source=row["artwork_source"],
        color_primary=row["color_primary"],
        color_secondary=row["color_secondary"],
        color_strategy=row["color_strategy"],
        fetched_at=row["fetched_at"],
    )
