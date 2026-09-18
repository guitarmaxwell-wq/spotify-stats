from datetime import datetime, timedelta, timezone

from pipeline.album_cache import AlbumCache, AlbumRecord, utcnow

MBID = "28b0ad2b-1d23-4940-b43e-5425ea752609"


def _rec(**kw):
    base = dict(
        mbid=MBID, artist="Nujabes", title="Metaphorical Music", release_year=2003,
        tracklist=["Blessing It", "Luv(sic)"], genre_tags=[["jazz rap", 5]],
        genre_id="hip-hop",
        artwork_url=f"https://coverartarchive.org/release/{MBID}/front-500",
        artwork_source="coverartarchive",
        color_primary="#c8a05a", color_secondary="#3f6f8f", color_strategy="dominant",
    )
    base.update(kw)
    return AlbumRecord(**base)


def _db(tmp_path):
    return AlbumCache(tmp_path / "albums.sqlite3")


def test_roundtrip_preserves_every_cached_field(tmp_path):
    with _db(tmp_path) as cache:
        cache.put(_rec())
        got = cache.get(MBID)
    assert got is not None
    assert got.artist == "Nujabes"
    assert got.tracklist == ["Blessing It", "Luv(sic)"]
    assert got.genre_tags == [["jazz rap", 5]]
    assert got.artwork_source == "coverartarchive"
    assert got.colors == {"primary": "#c8a05a", "secondary": "#3f6f8f"}
    assert got.fetched_at  # stamped on write


def test_missing_key_is_a_miss(tmp_path):
    with _db(tmp_path) as cache:
        assert cache.get("no-such-mbid") is None
        assert cache.misses == 1


def test_cache_survives_reopening_the_file(tmp_path):
    with _db(tmp_path) as cache:
        cache.put(_rec())
    with _db(tmp_path) as reopened:
        assert reopened.get(MBID).title == "Metaphorical Music"


def test_put_is_an_upsert(tmp_path):
    with _db(tmp_path) as cache:
        cache.put(_rec())
        cache.put(_rec(artwork_source="deezer", artwork_url="https://cdn/x.jpg"))
        assert cache.stats()["albums"] == 1
        assert cache.get(MBID).artwork_source == "deezer"


def test_ttl_expires_old_rows(tmp_path):
    old = (datetime.now(timezone.utc) - timedelta(days=45)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with _db(tmp_path) as cache:
        cache.put(_rec(fetched_at=old))
        assert cache.get(MBID, ttl_days=30) is None    # stale -> re-resolve
        assert cache.get(MBID, ttl_days=90) is not None
        assert cache.get(MBID, ttl_days=0) is not None  # TTL disabled
        assert cache.peek(MBID) is not None             # peek ignores the TTL


def test_record_without_a_timestamp_is_always_stale():
    assert AlbumRecord(mbid=MBID, fetched_at="").is_stale()
    assert AlbumRecord(mbid=MBID, fetched_at="garbage").is_stale()
    assert not AlbumRecord(mbid=MBID, fetched_at=utcnow()).is_stale()


def test_colors_is_none_when_only_half_a_pair_is_stored():
    assert AlbumRecord(mbid=MBID, color_primary="#fff").colors is None
    assert AlbumRecord(mbid=MBID).colors is None


def test_stats_break_coverage_down_by_source(tmp_path):
    with _db(tmp_path) as cache:
        cache.put(_rec())
        cache.put(_rec(mbid="b", artwork_source="deezer", artwork_url="https://cdn/b.jpg"))
        cache.put(_rec(mbid="c", artwork_source="none", artwork_url=None,
                       color_primary=None, color_secondary=None))
        s = cache.stats()
    assert s["albums"] == 3
    assert s["with_artwork"] == 2
    assert s["with_colors"] == 2
    assert s["by_source"] == {"coverartarchive": 1, "deezer": 1, "none": 1}


def test_negative_artwork_results_are_cached_too(tmp_path):
    """'CAA and Deezer both have nothing' is an answer worth remembering."""
    with _db(tmp_path) as cache:
        cache.put(_rec(artwork_source="none", artwork_url=None,
                       color_primary=None, color_secondary=None))
        got = cache.get(MBID)
    assert got.artwork_source == "none"
    assert got.colors is None
