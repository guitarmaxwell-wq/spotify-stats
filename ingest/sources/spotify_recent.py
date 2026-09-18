"""Spotify ``GET /v1/me/player/recently-played`` — forward sync only.

**Read this before assuming this module can fill a shelf.** It cannot. Spotify
retains roughly the last 50 plays and the ``before``/``after`` cursors only move
*inside* that buffer; paging past it returns an empty ``items`` array. There is
no historical endpoint. See ``docs/DATA_SOURCES.md`` §1.

What this module is genuinely good for: keeping a shelf filling *going forward*,
from the moment the user links. Each poll asks for everything after the
high-water mark, so repeated polls are cheap and idempotent.

The failure mode that matters is **the gap**. Play 60 tracks between two polls
and the oldest 10 are gone from Spotify's buffer before we ever see them. We
cannot recover them, so we do the next best thing: detect it (a poll that comes
back at the 50-item ceiling almost certainly means we lost some), count it on
the cursor, and let the UI say so rather than quietly under-counting an album
forever.
"""

from __future__ import annotations

import time
from datetime import datetime

from ..schema import InvalidPlayEvent, IngestResult, Source, make_event
from ..store import PlayStore
from .base import AuthRequired, HttpTransport, build_url, collect

RECENTLY_PLAYED = "https://api.spotify.com/v1/me/player/recently-played"

#: Spotify's documented maximum, and also the size of the entire buffer.
PAGE_LIMIT = 50

#: Poll at least this often to keep the gap risk low. 50 tracks is roughly
#: three hours of continuous listening, so 30 minutes leaves a lot of headroom.
SUGGESTED_POLL_INTERVAL_S = 30 * 60

SCOPES = ("user-read-recently-played",)


def parse_item(item: dict):
    """One ``items[]`` entry -> PlayEvent.

    ``played_at`` is ISO-8601 with millisecond precision and marks when the
    track *stopped*. We floor it to whole seconds for the schema and keep the
    millisecond value only for the cursor, where the extra precision prevents
    re-delivering the boundary play.
    """
    track = item.get("track") or {}
    album = track.get("album") or {}
    artists = track.get("artists") or []
    return make_event(
        ts=played_at_ms(item.get("played_at")) // 1000,
        artist=(artists[0].get("name") if artists else None),
        track=track.get("name"),
        album=album.get("name"),
        source=Source.SPOTIFY_RECENT,
        # No ms_played here — the endpoint does not report it. Do not infer one.
        duration_ms=track.get("duration_ms"),
        foreign_id=track.get("uri"),
    )


def played_at_ms(value) -> int:
    """Parse Spotify's ``played_at`` to Unix milliseconds."""
    if not value:
        raise InvalidPlayEvent("missing played_at")
    s = str(value).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError as exc:
        raise InvalidPlayEvent(f"unparseable played_at {value!r}") from exc
    return int(dt.timestamp() * 1000)


class SpotifyRecentSource:
    """Incremental poller for one authenticated Spotify user.

    ``access_token`` is passed in already-valid. Refreshing is the caller's job
    (the app does it in ``app/src/link/spotifyAuth.ts``); a source that could
    silently re-auth would be a source that could silently prompt.
    """

    name = Source.SPOTIFY_RECENT

    def __init__(self, access_token: str, transport=None):
        if not access_token:
            raise AuthRequired("a Spotify access token is required")
        self.access_token = access_token
        self.transport = transport or HttpTransport(min_interval=0.2)

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.access_token}"}

    def fetch_page(self, after_ms: int = 0, limit: int = PAGE_LIMIT) -> dict:
        params = {"limit": min(limit, PAGE_LIMIT)}
        if after_ms:
            params["after"] = after_ms
        return self.transport(build_url(RECENTLY_PLAYED, params), self._headers())

    def sync(self, store: PlayStore, *, limit: int = PAGE_LIMIT) -> IngestResult:
        cur = store.cursor(self.name)
        # after_ms is derived from a whole-second mark, so the play sitting
        # exactly on the boundary comes back once more. That is deliberate:
        # the store de-duplicates it for free, whereas rounding the cursor up
        # to avoid it would risk skipping a play instead.
        body = self.fetch_page(cur.after_ms, limit)
        items = body.get("items") or []

        events, invalid = [], 0
        high_ms = cur.after_ms
        for item in items:
            try:
                events.append(parse_item(item))
                high_ms = max(high_ms, played_at_ms(item.get("played_at")))
            except InvalidPlayEvent:
                invalid += 1

        # A full page means Spotify had at least as many plays as it would give
        # us. On a first sync that is expected (we are draining the buffer); on
        # an incremental one it means plays probably fell out of the buffer
        # before we asked.
        gap = len(items) >= min(limit, PAGE_LIMIT) and bool(cur.after_ms)

        warnings = []
        if gap:
            warnings.append(
                "the poll came back full — some plays may have aged out of "
                "Spotify's 50-track buffer before this sync and cannot be recovered"
            )

        result = collect(
            self.name, store, events, invalid=invalid,
            last_ts=high_ms // 1000, gap=gap, warnings=warnings,
        )
        result.cursor = store.cursor(self.name).to_dict()
        return result

    def sync_forever(self, store: PlayStore, *, interval_s: int = SUGGESTED_POLL_INTERVAL_S,
                     iterations: int | None = None, sleep=time.sleep):
        """Poll on a schedule. Yields each :class:`IngestResult`.

        This is what "keeps filling as they listen" actually requires, and it
        is also the honest cost of the Spotify path: something must be running.
        On device that is a foreground refresh; as a daemon it is a server.
        """
        n = 0
        while iterations is None or n < iterations:
            yield self.sync(store)
            n += 1
            if iterations is None or n < iterations:
                sleep(interval_s)
