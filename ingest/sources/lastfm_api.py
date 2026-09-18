"""Last.fm ``user.getRecentTracks`` — the only source that can backfill.

An API key and a public username. No OAuth, no allowlist, no per-user approval
from anyone. This is the path that survives App Store review; see
``docs/DATA_SOURCES.md`` for why the alternatives do not.

Two paging details that are easy to get wrong and expensive to debug:

* **The window is pinned.** We pass an explicit ``to=`` of the sync's start time.
  Without it, scrobbles arriving mid-backfill shift every page boundary and you
  silently skip tracks. With it, pages are stable for the whole run.
* **Now-playing has no timestamp.** The currently-playing track comes back with
  ``@attr.nowplaying`` and no ``date``. It is not a play yet; we drop it and it
  arrives properly on the next sync.
"""

from __future__ import annotations

import time

from ..schema import InvalidPlayEvent, IngestResult, Source, make_event
from ..store import PlayStore
from .base import AuthRequired, HttpTransport, SourceError, build_url, collect

API_ROOT = "https://ws.audioscrobbler.com/2.0/"
PAGE_SIZE = 200
MAX_PAGES = 5000  # ~1M scrobbles; a runaway loop stops here rather than forever

#: How far behind the cursor an incremental sync re-reads. See ``sync``.
LOOKBACK_S = 14 * 24 * 3600


def _text(node) -> str | None:
    if isinstance(node, dict):
        v = node.get("#text")
        return v.strip() if isinstance(v, str) and v.strip() else None
    if isinstance(node, str):
        return node.strip() or None
    return None


def _mbid(node) -> str | None:
    if isinstance(node, dict):
        v = node.get("mbid")
        return v.strip() if isinstance(v, str) and v.strip() else None
    return None


def _as_list(v) -> list:
    """Last.fm returns a bare object instead of a list when there is one item."""
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def parse_track(raw: dict):
    """One API track object -> PlayEvent, or None if it is not a play."""
    attr = raw.get("@attr") or {}
    if str(attr.get("nowplaying", "")).lower() == "true":
        return None
    date = raw.get("date") or {}
    uts = date.get("uts")
    if not uts:
        return None
    return make_event(
        ts=uts,
        artist=_text(raw.get("artist")),
        track=raw.get("name"),
        album=_text(raw.get("album")),
        source=Source.LASTFM,
        artist_mbid=_mbid(raw.get("artist")),
        album_mbid=_mbid(raw.get("album")),
        track_mbid=raw.get("mbid") or None,
    )


class LastfmSource:
    """Full or incremental history for one Last.fm username."""

    name = Source.LASTFM

    def __init__(self, username: str, api_key: str, transport=None, *,
                 page_size: int = PAGE_SIZE, on_progress=None):
        if not username:
            raise AuthRequired("a Last.fm username is required")
        if not api_key:
            raise AuthRequired(
                "a Last.fm API key is required — create one at "
                "https://www.last.fm/api/account/create and set LASTFM_API_KEY"
            )
        self.username = username
        self.api_key = api_key
        self.transport = transport or HttpTransport(min_interval=1.0)
        self.page_size = page_size
        self.on_progress = on_progress

    def _url(self, page: int, from_uts: int, to_uts: int) -> str:
        return build_url(API_ROOT, {
            "method": "user.getrecenttracks",
            "user": self.username,
            "api_key": self.api_key,
            "format": "json",
            "limit": self.page_size,
            "page": page,
            "from": from_uts,
            "to": to_uts,
        })

    def fetch(self, from_uts: int = 0, to_uts: int = 0, max_pages: int = MAX_PAGES):
        """Yield ``(events, invalid_count, total_pages)`` one page at a time."""
        to_uts = to_uts or int(time.time())
        page = 1
        total_pages = 1
        while page <= total_pages and page <= max_pages:
            body = self.transport(self._url(page, from_uts, to_uts), {})
            if "error" in body:
                msg = f"Last.fm error {body.get('error')}: {body.get('message')}"
                if body.get("error") in (4, 10, 26):  # auth / bad key / suspended
                    raise AuthRequired(msg)
                if body.get("error") == 6:
                    raise SourceError(f"no such Last.fm user {self.username!r}")
                raise SourceError(msg)

            recent = body.get("recenttracks") or {}
            attr = recent.get("@attr") or {}
            try:
                total_pages = max(1, int(attr.get("totalPages") or 1))
            except (TypeError, ValueError):
                total_pages = 1

            events, invalid = [], 0
            for raw in _as_list(recent.get("track")):
                try:
                    ev = parse_track(raw)
                except InvalidPlayEvent:
                    invalid += 1
                    continue
                if ev is not None:
                    events.append(ev)
            yield events, invalid, total_pages
            if self.on_progress:
                self.on_progress(page, total_pages)
            page += 1

    def sync(self, store: PlayStore, *, full: bool = False,
             max_pages: int = MAX_PAGES) -> IngestResult:
        """Incremental by default; ``full=True`` re-walks from the beginning.

        A full re-walk is safe at any time — the store de-duplicates — it is
        just slow (roughly one request per 200 scrobbles at 1 req/s).
        """
        cur = store.cursor(self.name)
        # Re-walk a lookback window rather than resuming exactly at the mark.
        # Offline scrobblers (phones out of signal) upload batches carrying
        # *old* timestamps, which would land behind a tight cursor and be lost
        # forever. Re-fetching a fortnight costs a few pages and the store
        # de-duplicates all of it.
        from_uts = 0 if full or not cur.last_ts else max(0, cur.last_ts - LOOKBACK_S)
        to_uts = int(time.time())

        total = IngestResult(source=self.name)
        truncated = False
        total_pages_seen = 0
        for events, invalid, total_pages in self.fetch(from_uts, to_uts, max_pages):
            total_pages_seen = total_pages
            # advance=False: pages arrive newest-first, so the high-water mark
            # is only trustworthy once the last page has landed.
            total.merge(collect(self.name, store, events, invalid=invalid, advance=False))
            # `total_pages` is known from the first page, so this must NOT break
            # out of the loop -- doing so stopped every run after one page and
            # made a full backfill impossible. `fetch` already stops at
            # max_pages; all that is left is to report it afterwards.
            if total_pages > max_pages:
                truncated = True

        if truncated:
            total.warnings.append(
                f"stopped at page {max_pages} of {total_pages_seen or max_pages}; "
                "run again to continue"
            )

        if not truncated:
            # The window was pinned at to_uts, so everything up to it is now in
            # the store — even if every page came back empty, which is the
            # normal case for a user who has not listened to anything since the
            # last sync.
            store.advance_cursor(self.name, last_ts=to_uts, synced_at=int(time.time()))
            store.save_state()
        total.cursor = store.cursor(self.name).to_dict()
        return total
