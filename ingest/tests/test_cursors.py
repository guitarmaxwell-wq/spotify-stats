"""Incremental cursor logic.

These are the tests that matter most in this package. A normalization bug shows
up as one odd-looking album; a cursor bug silently loses plays forever, and the
user never finds out because the shelf just looks slightly wrong.
"""

import time
import urllib.parse

import pytest

from ingest.schema import Source, make_event
from ingest.sources.lastfm_api import LOOKBACK_S, LastfmSource
from ingest.sources.spotify_recent import PAGE_LIMIT, SpotifyRecentSource
from ingest.store import PlayStore


@pytest.fixture
def store(tmp_path):
    return PlayStore(tmp_path / "plays.jsonl", tmp_path / "state.json").load()


def params(url: str) -> dict:
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))


# --------------------------------------------------------------- transports --

class FakeSpotify:
    """Serves a fixed timeline, honouring the ``after`` cursor like Spotify."""

    def __init__(self, plays, buffer_size=PAGE_LIMIT):
        # plays: list of (played_at_ms, artist, track)
        self.plays = sorted(plays)
        self.buffer_size = buffer_size
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append(params(url))
        after = int(self.calls[-1].get("after", 0))
        limit = int(self.calls[-1].get("limit", PAGE_LIMIT))
        # Spotify only retains the last N plays at all.
        retained = self.plays[-self.buffer_size:]
        items = [p for p in retained if p[0] > after][:limit]
        return {"items": [{
            "played_at": _iso_ms(ms),
            "track": {"name": track, "duration_ms": 200000,
                      "artists": [{"name": artist}],
                      "album": {"name": "Alb"}},
        } for ms, artist, track in items]}


def _iso_ms(ms: int) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


class FakeLastfm:
    """Pages newest-first with a totalPages attr, like the real API."""

    def __init__(self, plays, page_size=2, fail_on_page=None):
        self.plays = sorted(plays, reverse=True)  # newest first
        self.page_size = page_size
        self.fail_on_page = fail_on_page
        self.calls = []

    def __call__(self, url, headers):
        q = params(url)
        self.calls.append(q)
        page = int(q.get("page", 1))
        if self.fail_on_page and page == self.fail_on_page:
            raise RuntimeError("network died mid-backfill")
        frm, to = int(q.get("from", 0) or 0), int(q.get("to", 0) or 0)
        window = [p for p in self.plays if p[0] >= frm and (not to or p[0] <= to)]
        total_pages = max(1, -(-len(window) // self.page_size))
        chunk = window[(page - 1) * self.page_size: page * self.page_size]
        return {"recenttracks": {
            "@attr": {"totalPages": str(total_pages), "page": str(page)},
            "track": [{
                "artist": {"#text": artist, "mbid": ""},
                "album": {"#text": "Alb", "mbid": ""},
                "name": track, "mbid": "",
                "date": {"uts": str(uts)},
            } for uts, artist, track in chunk],
        }}


# ------------------------------------------------------ spotify forward sync --

def test_first_poll_sends_no_after_and_sets_the_high_water_mark(store):
    api = FakeSpotify([(1_000_000, "A", "t1"), (1_200_000, "A", "t2")])
    result = SpotifyRecentSource("tok", transport=api).sync(store)

    assert "after" not in api.calls[0]
    assert result.added == 2
    assert store.cursor(Source.SPOTIFY_RECENT).last_ts == 1200  # ms floored to s


def test_second_poll_asks_only_for_what_is_new(store):
    api = FakeSpotify([(1_000_000, "A", "t1"), (1_200_000, "A", "t2")])
    src = SpotifyRecentSource("tok", transport=api)
    src.sync(store)

    api.plays.append((1_500_000, "A", "t3"))
    result = src.sync(store)

    assert api.calls[1]["after"] == "1200000"
    assert result.added == 1
    assert store.cursor(Source.SPOTIFY_RECENT).last_ts == 1500


def test_repeated_polls_with_nothing_new_add_nothing_and_do_not_rewind(store):
    api = FakeSpotify([(1_000_000, "A", "t1")])
    src = SpotifyRecentSource("tok", transport=api)
    src.sync(store)
    before = store.cursor(Source.SPOTIFY_RECENT).last_ts

    for _ in range(3):
        result = src.sync(store)
        assert result.added == 0

    assert store.cursor(Source.SPOTIFY_RECENT).last_ts == before
    assert len(store.events) == 1


def test_the_boundary_play_comes_back_once_and_is_de_duplicated(store):
    """after= is whole-second, so the play on the mark repeats. It must not double."""
    api = FakeSpotify([(1_200_500, "A", "t1")])
    src = SpotifyRecentSource("tok", transport=api)
    src.sync(store)
    result = src.sync(store)

    assert result.fetched == 1  # Spotify did re-deliver it
    assert result.added == 0    # but the store refused it
    assert result.duplicates == 1
    assert len(store.events) == 1


def test_a_full_page_on_an_incremental_poll_is_flagged_as_a_possible_gap(store):
    plays = [(1_000_000 + i * 1000, "A", f"t{i}") for i in range(PAGE_LIMIT + 10)]
    api = FakeSpotify(plays[:1])
    src = SpotifyRecentSource("tok", transport=api)
    src.sync(store)  # establishes a cursor

    api.plays = sorted(plays)  # user listened to 60 tracks between polls
    result = src.sync(store)

    assert result.cursor["suspected_gaps"] == 1
    assert any("aged out" in w for w in result.warnings)
    # And the plays that fell out of the buffer really are unrecoverable.
    assert len(store.events) < len(plays)


def test_a_full_first_poll_is_not_a_gap(store):
    plays = [(1_000_000 + i * 1000, "A", f"t{i}") for i in range(PAGE_LIMIT)]
    result = SpotifyRecentSource("tok", transport=FakeSpotify(plays)).sync(store)
    assert result.cursor["suspected_gaps"] == 0
    assert result.warnings == []


def test_cursors_survive_a_restart(store, tmp_path):
    api = FakeSpotify([(1_000_000, "A", "t1")])
    SpotifyRecentSource("tok", transport=api).sync(store)

    reopened = PlayStore(tmp_path / "plays.jsonl", tmp_path / "state.json").load()
    assert reopened.cursor(Source.SPOTIFY_RECENT).last_ts == 1000
    assert len(reopened.events) == 1

    api.plays.append((1_100_000, "A", "t2"))
    SpotifyRecentSource("tok", transport=api).sync(reopened)
    assert api.calls[-1]["after"] == "1000000"


def test_a_cursor_never_moves_backwards(store):
    store.advance_cursor(Source.SPOTIFY_RECENT, last_ts=5000)
    store.advance_cursor(Source.SPOTIFY_RECENT, last_ts=1)
    assert store.cursor(Source.SPOTIFY_RECENT).last_ts == 5000


def test_a_backfill_import_does_not_rewind_the_forward_sync_cursor(store):
    """Importing 2020 history must not make tomorrow's poll re-walk from 2020."""
    SpotifyRecentSource("tok", transport=FakeSpotify([(1_700_000_000_000, "A", "t")])).sync(store)
    live = store.cursor(Source.SPOTIFY_RECENT).last_ts

    old = [make_event(ts=1_600_000_000, artist="B", track=f"t{i}",
                      source=Source.SPOTIFY_EXPORT, ms_played=200_000)
           for i in range(3)]
    accepted, _ = store.extend(old)
    store.commit(Source.SPOTIFY_EXPORT, accepted)

    assert store.cursor(Source.SPOTIFY_RECENT).last_ts == live
    assert store.cursor(Source.SPOTIFY_EXPORT).last_ts == 1_600_000_000


# ------------------------------------------------------------ lastfm paging --

def test_a_full_backfill_walks_every_page(store):
    plays = [(1000 + i, "A", f"t{i}") for i in range(7)]
    api = FakeLastfm(plays, page_size=2)
    result = LastfmSource("max", "key", transport=api).sync(store, full=True)

    assert result.added == 7
    assert [c["page"] for c in api.calls] == ["1", "2", "3", "4"]


def test_the_backfill_window_is_pinned_so_pages_cannot_shift(store):
    api = FakeLastfm([(1000 + i, "A", f"t{i}") for i in range(7)], page_size=2)
    LastfmSource("max", "key", transport=api).sync(store, full=True)
    tos = {c["to"] for c in api.calls}
    assert len(tos) == 1, "every page must use the same `to`, or rows slip between pages"


def test_an_interrupted_backfill_keeps_its_plays_but_not_its_cursor(store, tmp_path):
    """The failure that would otherwise lose history permanently."""
    plays = [(1000 + i, "A", f"t{i}") for i in range(7)]
    api = FakeLastfm(plays, page_size=2, fail_on_page=3)

    with pytest.raises(RuntimeError):
        LastfmSource("max", "key", transport=api).sync(store, full=True)

    reopened = PlayStore(tmp_path / "plays.jsonl", tmp_path / "state.json").load()
    assert len(reopened.events) == 4          # pages 1-2 were persisted
    assert reopened.cursor(Source.LASTFM).last_ts == 0  # but we are NOT caught up

    # Resuming re-walks from the beginning and completes, without duplicating.
    ok = FakeLastfm(plays, page_size=2)
    result = LastfmSource("max", "key", transport=ok).sync(reopened)
    assert result.duplicates == 4
    assert len(reopened.events) == 7


def test_an_incremental_sync_re_reads_a_lookback_window(store):
    """Offline scrobblers upload old timestamps; a tight cursor would lose them."""
    now = int(time.time())  # the sync pins `to` at the real clock, so must we
    api = FakeLastfm([(now - 10, "A", "t1")], page_size=200)
    src = LastfmSource("max", "key", transport=api)
    src.sync(store, full=True)

    src.sync(store)
    asked_from = int(api.calls[-1]["from"])
    cursor = store.cursor(Source.LASTFM).last_ts
    assert asked_from == cursor - LOOKBACK_S
    assert asked_from < now - 10, "the window must reach behind the newest known play"


def test_a_late_arriving_backdated_scrobble_is_still_picked_up(store):
    now = int(time.time())
    plays = [(now - 10, "A", "t1")]
    api = FakeLastfm(plays, page_size=200)
    src = LastfmSource("max", "key", transport=api)
    src.sync(store, full=True)

    # A phone that was offline uploads a play from two days ago.
    plays.append((now - 2 * 24 * 3600, "A", "t-late"))
    api.plays = sorted(plays, reverse=True)
    result = src.sync(store)

    assert result.added == 1
    assert any(e.track == "t-late" for e in store.events)


def test_an_empty_incremental_sync_still_advances_the_clock(store):
    api = FakeLastfm([(1000, "A", "t1")], page_size=200)
    src = LastfmSource("max", "key", transport=api)
    src.sync(store, full=True)
    first = store.cursor(Source.LASTFM).last_ts

    src.sync(store)
    assert store.cursor(Source.LASTFM).last_ts >= first


# ----------------------------------------------------------------- dedupe ----

def test_the_same_play_from_spotify_and_lastfm_is_stored_once(store):
    # Last.fm stamps the start, Spotify the end of the same 3-minute track.
    lastfm = make_event(ts=1_000_000, artist="Oasis", track="Wonderwall",
                        album="Morning Glory", source=Source.LASTFM)
    spotify = make_event(ts=1_000_180, artist="Oasis", track="Wonderwall - Remastered",
                         album="Morning Glory", source=Source.SPOTIFY_RECENT,
                         duration_ms=180_000)
    assert store.add(lastfm) is True
    assert store.add(spotify) is False
    assert len(store.events) == 1


def test_the_same_track_played_twice_in_a_row_counts_twice(store):
    """Dedupe must not punish someone with a song on repeat."""
    a = make_event(ts=1_000_000, artist="Oasis", track="Wonderwall",
                   source=Source.LASTFM)
    b = make_event(ts=1_000_180, artist="Oasis", track="Wonderwall",
                   source=Source.LASTFM)
    assert store.add(a) is True
    assert store.add(b) is True
    assert len(store.events) == 2


def test_re_importing_the_same_export_twice_adds_nothing(store):
    events = [make_event(ts=1_000_000 + i, artist="A", track=f"t{i}",
                         source=Source.SPOTIFY_EXPORT, ms_played=200_000)
              for i in range(5)]
    first, _ = store.extend(events)
    assert len(first) == 5
    second, dupes = store.extend(events)
    assert second == [] and dupes == 5


def test_a_truncated_last_line_does_not_destroy_the_store(tmp_path):
    p = tmp_path / "plays.jsonl"
    ev = make_event(ts=1, artist="A", track="T", source=Source.LASTFM)
    p.write_text(ev.to_json() + "\n" + '{"ts": 2, "artist": "B"', encoding="utf-8")

    store = PlayStore(p, tmp_path / "state.json").load()
    assert len(store.events) == 1
    assert store.corrupt_lines == 1
