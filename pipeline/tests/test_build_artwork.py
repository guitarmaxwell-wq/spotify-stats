"""The seam between the artwork resolver, the album cache and collection.json."""

from datetime import datetime, timedelta, timezone

from pipeline.album_cache import AlbumCache, AlbumRecord
from pipeline.artwork import Artwork
from pipeline.build import _caa_front_flag, resolve_artwork
from pipeline.colors import MIN_CONTRAST, UI_BACKGROUND, contrast_ratio, hex_to_rgb


def _readable(hex_color):
    return contrast_ratio(hex_to_rgb(hex_color), hex_to_rgb(UI_BACKGROUND)) >= MIN_CONTRAST - 1e-9

MBID = "28b0ad2b-1d23-4940-b43e-5425ea752609"
PNG_RED = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x02\x00\x00\x00\x02\x08\x02"
    b"\x00\x00\x00\xfd\xd4\x9as\x00\x00\x00\x16IDAT\x08\x99c\xf8\xcf\xc0\xf0\x9f"
    b"\x81\x81\x01\x00\x0e\xfe\x02\xfe\xa7\x8f\x1d\xbd\x00\x00\x00\x00IEND\xaeB`\x82"
)


class StubResolver:
    """Stands in for ArtworkResolver; counts how often it is actually asked."""

    def __init__(self, art: Artwork, offline: bool = False):
        self.art = art
        self.offline = offline
        self.calls = 0

    def resolve(self, mbid, artist, album, caa_front=None, track_count=None):
        self.calls += 1
        self.seen = {"mbid": mbid, "caa_front": caa_front, "track_count": track_count}
        return self.art

    def image_for(self, url):
        return self.art.image


def _cache(tmp_path):
    return AlbumCache(tmp_path / "albums.sqlite3")


# -- the MusicBrainz front-cover hint --------------------------------------

def test_caa_front_flag_reading():
    assert _caa_front_flag({"cover-art-archive": {"front": True}}) is True
    assert _caa_front_flag({"cover-art-archive": {"front": False}}) is False
    assert _caa_front_flag({"cover-art-archive": {}}) is None
    assert _caa_front_flag({}) is None


def test_front_flag_is_passed_through_to_the_resolver(tmp_path):
    r = StubResolver(Artwork(None, "none", "caa_absent"))
    with _cache(tmp_path) as cache:
        resolve_artwork(MBID, "A", "B", {"cover-art-archive": {"front": False}},
                        r, cache, 30, tracklist=["x", "y"])
    assert r.seen["caa_front"] is False
    assert r.seen["track_count"] == 2


# -- caching behaviour ------------------------------------------------------

def test_first_resolve_writes_url_source_and_colors(tmp_path):
    art = Artwork("https://coverartarchive.org/x/front-500", "coverartarchive", None, PNG_RED)
    r = StubResolver(art)
    with _cache(tmp_path) as cache:
        out = resolve_artwork(MBID, "A", "B", {}, r, cache, 30, tracklist=["t"])
        assert out["artwork_source"] == "coverartarchive"
        assert out["cover_url"] == art.url
        assert set(out["colors"]) == {"primary", "secondary"}
        stored = cache.get(MBID)
    assert stored.artwork_url == art.url
    assert stored.colors == out["colors"]
    assert stored.tracklist == ["t"]


def test_second_run_is_served_from_the_cache(tmp_path):
    art = Artwork("https://coverartarchive.org/x/front-500", "coverartarchive", None, PNG_RED)
    r = StubResolver(art)
    with _cache(tmp_path) as cache:
        first = resolve_artwork(MBID, "A", "B", {}, r, cache, 30)
        second = resolve_artwork(MBID, "A", "B", {}, r, cache, 30)
    assert r.calls == 1
    assert second["_from_cache"] is True
    assert second["colors"] == first["colors"]


def test_a_cached_miss_is_not_retried_inside_the_ttl(tmp_path):
    r = StubResolver(Artwork(None, "none", "deezer_no_match"))
    with _cache(tmp_path) as cache:
        resolve_artwork(MBID, "A", "B", {}, r, cache, 30)
        out = resolve_artwork(MBID, "A", "B", {}, r, cache, 30)
    assert r.calls == 1
    assert out["cover_url"] is None and out["artwork_source"] == "none"


def test_an_album_with_no_artwork_still_gets_a_gradient_pair(tmp_path):
    r = StubResolver(Artwork(None, "none", "deezer_no_match"))
    with _cache(tmp_path) as cache:
        fresh = resolve_artwork(MBID, "A", "B", {}, r, cache, 30)
        cached = resolve_artwork(MBID, "A", "B", {}, r, cache, 30)
        stored = cache.peek(MBID)
    for out in (fresh, cached):
        assert out["colors"]["primary"] and out["colors"]["secondary"]
        assert _readable(out["colors"]["primary"])
        assert _readable(out["colors"]["secondary"])
        assert out["color_strategy"] == "neutral-fallback"
    # ...but the cache keeps honest NULLs, so a later run that finds artwork
    # is not fooled into thinking colours were already extracted.
    assert stored.color_primary is None


def test_a_stale_row_is_re_resolved(tmp_path):
    old = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%dT%H:%M:%SZ")
    art = Artwork("https://cdn/x.jpg", "deezer", None, PNG_RED)
    r = StubResolver(art)
    with _cache(tmp_path) as cache:
        cache.put(AlbumRecord(mbid=MBID, artist="A", title="B", artwork_url=None,
                              artwork_source="none", fetched_at=old))
        out = resolve_artwork(MBID, "A", "B", {}, r, cache, 30)
    assert r.calls == 1
    assert out["artwork_source"] == "deezer"


def test_offline_run_never_records_a_negative_result(tmp_path):
    """Offline cannot tell 'upstream has nothing' from 'we could not ask'."""
    r = StubResolver(Artwork(None, "none", "offline"), offline=True)
    with _cache(tmp_path) as cache:
        resolve_artwork(MBID, "A", "B", {}, r, cache, 30)
        assert cache.peek(MBID) is None


def test_no_resolver_falls_back_to_whatever_is_already_cached(tmp_path):
    with _cache(tmp_path) as cache:
        cache.put(AlbumRecord(mbid=MBID, artist="A", title="B",
                              artwork_url="https://cdn/x.jpg", artwork_source="deezer",
                              color_primary="#aabbcc", color_secondary="#112233"))
        out = resolve_artwork(MBID, "A", "B", {}, None, cache, 30)
    assert out["cover_url"] == "https://cdn/x.jpg"
    assert out["colors"] == {"primary": "#aabbcc", "secondary": "#112233"}


def test_album_without_an_mbid_still_resolves_artwork(tmp_path):
    art = Artwork("https://cdn/x.jpg", "deezer", None, PNG_RED)
    r = StubResolver(art)
    with _cache(tmp_path) as cache:
        out = resolve_artwork(None, "A", "B", {}, r, cache, 30)
    assert out["cover_url"] == "https://cdn/x.jpg"
    assert out["colors"]


def test_colors_can_be_skipped(tmp_path):
    art = Artwork("https://cdn/x.jpg", "deezer", None, PNG_RED)
    with _cache(tmp_path) as cache:
        out = resolve_artwork(MBID, "A", "B", {}, StubResolver(art), cache, 30,
                              with_colors=False)
    assert out["cover_url"] and out["colors"] is None
