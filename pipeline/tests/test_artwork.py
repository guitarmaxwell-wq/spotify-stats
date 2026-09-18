import pipeline.artwork as artwork
from pipeline.artwork import (
    SOURCE_CAA,
    SOURCE_DEEZER,
    SOURCE_NONE,
    ArtworkResolver,
    RateLimiter,
    deezer_cover_url,
    pick_deezer_album,
    score_deezer_candidate,
)


def dz(title, artist, **kw):
    cand = {
        "title": title,
        "artist": {"name": artist},
        "cover_big": f"https://cdn-images.dzcdn.net/{title}/500x500.jpg",
        "record_type": "album",
    }
    cand.update(kw)
    return cand


# -- Deezer matching (pure) -------------------------------------------------

def test_exact_match_scores_highest():
    cands = [dz("Donuts", "J Dilla"), dz("Donut Shop", "J Dilla")]
    assert pick_deezer_album("J Dilla", "Donuts", cands) is cands[0]


def test_matching_reuses_the_shared_normalizer():
    """Edition noise and artist-variant folding come from pipeline.normalize."""
    cands = [dz("Donuts (Deluxe Edition)", "J Dilla")]
    assert pick_deezer_album("J Dilla", "Donuts - Remastered", cands) is cands[0]

    trio = [dz("After Midnight", "Nat King Cole")]
    assert pick_deezer_album("The Nat King Cole Trio", "After Midnight", trio) is trio[0]


def test_wrong_artist_is_rejected_outright():
    cands = [dz("Donuts", "Various Artists"), dz("Donuts", "Some Tribute Band")]
    assert pick_deezer_album("J Dilla", "Donuts", cands) is None
    assert all(score_deezer_candidate("J Dilla", "Donuts", c) < 0 for c in cands)


def test_wrong_album_is_rejected_outright():
    cands = [dz("The Shining", "J Dilla")]
    assert pick_deezer_album("J Dilla", "Donuts", cands) is None


def test_album_preferred_over_single_and_track_count_breaks_ties():
    cands = [
        dz("Donuts", "J Dilla", record_type="single", nb_tracks=2),
        dz("Donuts", "J Dilla", record_type="album", nb_tracks=31),
    ]
    assert pick_deezer_album("J Dilla", "Donuts", cands, track_count=31) is cands[1]


def test_empty_candidate_list_and_untitled_entries():
    assert pick_deezer_album("J Dilla", "Donuts", []) is None
    assert score_deezer_candidate("J Dilla", "Donuts", {"artist": {"name": "J Dilla"}}) < 0


def test_cover_url_prefers_500px():
    assert deezer_cover_url({"cover_big": "big", "cover_xl": "xl"}) == "big"
    assert deezer_cover_url({"cover": "plain"}) == "plain"
    assert deezer_cover_url({}) is None


# -- rate limiter -----------------------------------------------------------

def test_rate_limiter_sleeps_once_the_window_is_full():
    slept = []
    now = [0.0]

    def clock():
        return now[0]

    def sleep(sec):
        slept.append(sec)
        now[0] += sec

    rl = RateLimiter(3, 5.0)
    for _ in range(3):
        rl.acquire(sleep=sleep, clock=clock)
    assert slept == []          # first three are free
    rl.acquire(sleep=sleep, clock=clock)
    assert slept and slept[0] == 5.0   # fourth waits out the window


def test_rate_limiter_honours_min_interval():
    slept = []
    now = [0.0]
    rl = RateLimiter(1000, 1.0, min_interval=0.5)
    rl.acquire(sleep=lambda s: (slept.append(s), now.__setitem__(0, now[0] + s)),
               clock=lambda: now[0])
    rl.acquire(sleep=lambda s: (slept.append(s), now.__setitem__(0, now[0] + s)),
               clock=lambda: now[0])
    assert slept == [0.5]


# -- resolver, with a fake session -----------------------------------------

class FakeResponse:
    def __init__(self, status=200, content=b"", json_data=None, ctype="image/jpeg"):
        self.status_code = status
        self.content = content
        self.headers = {"Content-Type": ctype}
        self._json = json_data

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class FakeSession:
    def __init__(self, routes):
        self.routes = routes
        self.headers = {}
        self.calls = []

    def get(self, url, params=None, timeout=None, allow_redirects=None):
        self.calls.append((url, params))
        for pattern, response in self.routes.items():
            if pattern in url:
                return response() if callable(response) else response
        return FakeResponse(404)


IMG = b"\x89PNG\r\n\x1a\n-fake-bytes"
MBID = "28b0ad2b-1d23-4940-b43e-5425ea752609"


def _resolver(tmp_path, routes, **kw):
    r = ArtworkResolver(cache_dir=tmp_path, session=FakeSession(routes), **kw)
    return r


def test_caa_hit_wins_and_never_touches_deezer(tmp_path):
    r = _resolver(tmp_path, {"coverartarchive.org": FakeResponse(200, IMG)})
    art = r.resolve(MBID, "Nujabes", "Metaphorical Music")
    assert art.source == SOURCE_CAA
    assert art.url == f"https://coverartarchive.org/release/{MBID}/front-500"
    assert art.image == IMG
    assert not any("deezer" in c[0] for c in r.session.calls)


def test_caa_404_is_a_normal_answer_and_falls_through_to_deezer(tmp_path):
    routes = {
        "coverartarchive.org": FakeResponse(404),
        "api.deezer.com": FakeResponse(200, json_data={"data": [dz("Donuts", "J Dilla")]}),
        "cdn-images.dzcdn.net": FakeResponse(200, IMG),
    }
    r = _resolver(tmp_path, routes)
    art = r.resolve(MBID, "J Dilla", "Donuts")
    assert art.source == SOURCE_DEEZER
    assert "dzcdn.net" in art.url


def test_caa_404_is_cached_so_it_is_only_asked_once(tmp_path):
    routes = {"coverartarchive.org": FakeResponse(404), "api.deezer.com": FakeResponse(200, json_data={"data": []})}
    r = _resolver(tmp_path, routes)
    r.resolve(MBID, "X", "Y")
    caa_calls = sum(1 for c in r.session.calls if "coverartarchive" in c[0])
    r2 = _resolver(tmp_path, routes)
    r2.resolve(MBID, "X", "Y")
    assert caa_calls == 1
    assert not any("coverartarchive" in c[0] for c in r2.session.calls)


def test_musicbrainz_front_flag_false_skips_the_caa_request(tmp_path):
    routes = {
        "coverartarchive.org": FakeResponse(200, IMG),
        "api.deezer.com": FakeResponse(200, json_data={"data": []}),
    }
    r = _resolver(tmp_path, routes)
    art = r.resolve(MBID, "X", "Y", caa_front=False)
    assert not any("coverartarchive" in c[0] for c in r.session.calls)
    assert art.source == SOURCE_NONE


def test_no_match_anywhere_reports_none(tmp_path):
    routes = {
        "coverartarchive.org": FakeResponse(404),
        "api.deezer.com": FakeResponse(200, json_data={"data": [dz("Something Else", "Nobody")]}),
    }
    r = _resolver(tmp_path, routes)
    art = r.resolve(MBID, "J Dilla", "Donuts")
    assert art.source == SOURCE_NONE and art.url is None
    assert art.reason == "deezer_no_match"


def test_deezer_can_be_disabled(tmp_path):
    routes = {"coverartarchive.org": FakeResponse(404)}
    r = _resolver(tmp_path, routes, use_deezer=False)
    art = r.resolve(MBID, "J Dilla", "Donuts")
    assert art.source == SOURCE_NONE
    assert not any("deezer" in c[0] for c in r.session.calls)


def test_offline_resolver_makes_no_requests(tmp_path):
    routes = {"coverartarchive.org": FakeResponse(200, IMG)}
    r = _resolver(tmp_path, routes, offline=True)
    art = r.resolve(MBID, "X", "Y")
    assert art.source == SOURCE_NONE
    assert r.session.calls == []


def test_warm_blob_cache_serves_the_image_without_a_request(tmp_path):
    routes = {"coverartarchive.org": FakeResponse(200, IMG)}
    r = _resolver(tmp_path, routes)
    art = r.resolve(MBID, "X", "Y")
    r2 = _resolver(tmp_path, routes, offline=True)
    assert r2.image_for(art.url) == IMG


def test_prefetch_warms_the_cache_so_the_real_pass_is_free(tmp_path):
    routes = {"coverartarchive.org": FakeResponse(200, IMG)}
    r = _resolver(tmp_path, routes)
    items = [(f"mbid-{n}", "A", f"B{n}", True, 10) for n in range(5)]
    r.prefetch(items, workers=4)
    assert len(r.session.calls) == 5
    assert r.counts["coverartarchive"] == 0  # a warm-up is not a resolution

    before = len(r.session.calls)
    for mbid, artist, album, front, tc in items:
        art = r.resolve(mbid, artist, album, front, tc)
        assert art.source == SOURCE_CAA
    assert len(r.session.calls) == before  # every one served from the blob cache
    assert r.counts["coverartarchive"] == 5


def test_prefetch_is_a_no_op_when_disabled_or_offline(tmp_path):
    routes = {"coverartarchive.org": FakeResponse(200, IMG)}
    items = [(MBID, "A", "B", True, 10)]
    r = _resolver(tmp_path, routes, offline=True)
    r.prefetch(items, workers=4)
    assert r.session.calls == []

    r2 = _resolver(tmp_path, routes)
    r2.prefetch(items, workers=1)
    assert r2.session.calls == []
    r2.prefetch([], workers=4)
    assert r2.session.calls == []


def test_spotify_is_not_a_source():
    """Licensing constraint, not a preference — see docs/CATALOG.md."""
    src = (artwork.__doc__ or "") + open(artwork.__file__, encoding="utf-8").read()
    assert "api.spotify.com" not in src
    assert "i.scdn.co" not in src
