"""Cover artwork resolution: Cover Art Archive first, Deezer as the fallback.

Why these two and never Spotify: see `docs/CATALOG.md`. Spotify's Developer
Terms forbid persistent storage of cover art and forbid modifying or deriving
from it — which is exactly what a stored URL plus an extracted gradient is. CAA
and Deezer carry no such restriction. **Do not add a Spotify artwork path
here.** It is a licensing constraint, not a preference.

Order of attack for one album:

1. **Cover Art Archive**, by MusicBrainz release MBID. No matching needed at
   all — the MBID *is* the key. CAA holds front covers for roughly 66% of MB
   releases, so a clean 404 is an ordinary answer and is cached as one.
   MusicBrainz already tells us in the release document whether a front cover
   exists (``cover-art-archive.front``), so most absences cost zero requests.
2. **Deezer**'s keyless public search, for the third CAA misses. This one does
   need matching, and it is matched with ``pipeline.normalize`` — the same
   normalizer the tracklist resolver uses. A wrong match here is worse than no
   match: it puts the wrong sleeve, and therefore the wrong gradient, on an
   album. The matcher is deliberately strict and is a pure function
   (:func:`pick_deezer_album`) so it can be tested without a network.

Every request and every downloaded image goes through the on-disk caches in
``pipeline/httpcache.py``, so reruns are free and an interrupted run resumes.
"""

from __future__ import annotations

import difflib
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import requests

from .httpcache import CACHE_DIR, BlobCache, JsonCache
from .normalize import artist_key, title_key

USER_AGENT = "CratesApp/0.1 ( https://github.com/guitarmaxwell-wq/spotify-stats )"
CAA_BASE = "https://coverartarchive.org"
DEEZER_SEARCH = "https://api.deezer.com/search/album"

#: Deezer publishes a limit of 50 requests per 5 seconds per IP.
DEEZER_LIMIT = 50
DEEZER_WINDOW = 5.0
#: CAA has no published hard limit; this keeps us to a polite ~3 req/s.
CAA_MIN_INTERVAL = 0.34

SOURCE_CAA = "coverartarchive"
SOURCE_DEEZER = "deezer"
SOURCE_NONE = "none"


@dataclass
class Artwork:
    url: str | None = None
    source: str = SOURCE_NONE
    reason: str | None = None
    #: Image bytes, when we had to download them anyway. Never persisted in the
    #: album store — only the URL and the derived colours are (see CATALOG.md).
    image: bytes | None = None

    @property
    def found(self) -> bool:
        return bool(self.url)


class RateLimiter:
    """Sliding-window limiter: at most ``max_calls`` in any ``window`` seconds.

    Held across the sleep, so it also serializes *starts* when several worker
    threads are prefetching: requests begin at the permitted rate while their
    (slow) transfers overlap, which is the whole point of the prefetch pool.
    """

    def __init__(self, max_calls: int, window: float, min_interval: float = 0.0):
        self.max_calls = max_calls
        self.window = window
        self.min_interval = min_interval
        self._calls: deque[float] = deque()
        self._lock = threading.Lock()

    def acquire(self, sleep=time.sleep, clock=time.monotonic) -> None:
        with self._lock:
            self._acquire(sleep, clock)

    def _acquire(self, sleep, clock) -> None:
        now = clock()
        if self.min_interval and self._calls:
            gap = self.min_interval - (now - self._calls[-1])
            if gap > 0:
                sleep(gap)
                now = clock()
        while self._calls and now - self._calls[0] >= self.window:
            self._calls.popleft()
        if len(self._calls) >= self.max_calls:
            wait = self.window - (now - self._calls[0])
            if wait > 0:
                sleep(wait)
                now = clock()
            while self._calls and now - self._calls[0] >= self.window:
                self._calls.popleft()
        self._calls.append(now)


# --------------------------------------------------------------------------
# Deezer matching — pure, testable, uses the shared normalizer
# --------------------------------------------------------------------------

def _ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def score_deezer_candidate(artist: str, album: str, cand: dict,
                           track_count: int | None = None) -> float:
    """Confidence that ``cand`` is the same album. Negative means "reject".

    Both sides go through ``pipeline.normalize`` first, so "The Nat King Cole
    Trio" matches "Nat King Cole" and "Donuts (Deluxe Edition)" matches
    "Donuts". Anything that does not clear both the artist and the title bar is
    rejected outright: a plausible-but-wrong sleeve is worse than a blank one.
    """
    cand_artist = ((cand.get("artist") or {}).get("name") or "").strip()
    cand_title = (cand.get("title") or "").strip()
    if not cand_title:
        return -1.0

    ka, kc = artist_key(artist), artist_key(cand_artist)
    ta, tc = title_key(album), title_key(cand_title)

    artist_exact = bool(ka) and ka == kc
    title_exact = bool(ta) and ta == tc
    artist_ratio = _ratio(ka, kc)
    title_ratio = _ratio(ta, tc)

    # "Various Artists" compilations match every artist badly; require the
    # title to carry the match in that case.
    if not artist_exact and artist_ratio < 0.86:
        return -1.0
    if not title_exact and title_ratio < 0.90:
        return -1.0

    score = artist_ratio + title_ratio
    score += 2.0 if artist_exact else 0.0
    score += 2.0 if title_exact else 0.0
    if (cand.get("record_type") or "").lower() == "album":
        score += 0.5
    nb = cand.get("nb_tracks") or 0
    if track_count and nb:
        score -= min(abs(nb - track_count), 40) / 40.0
    return score


def pick_deezer_album(artist: str, album: str, candidates: list[dict],
                      track_count: int | None = None) -> dict | None:
    """Best acceptable Deezer album for (artist, album), or None."""
    best, best_score = None, 0.0
    for cand in candidates or []:
        s = score_deezer_candidate(artist, album, cand, track_count)
        if s > best_score:
            best, best_score = cand, s
    return best


def deezer_cover_url(cand: dict) -> str | None:
    """Prefer the 500px sleeve, to match CAA's ``front-500``."""
    for key in ("cover_big", "cover_xl", "cover_medium", "cover"):
        url = cand.get(key)
        if url:
            return url
    return None


# --------------------------------------------------------------------------
# Resolver
# --------------------------------------------------------------------------

class ArtworkResolver:
    def __init__(self, cache_dir: Path = CACHE_DIR, offline: bool = False,
                 session: requests.Session | None = None, use_deezer: bool = True):
        self.offline = offline
        self.use_deezer = use_deezer
        self.json_cache = JsonCache(Path(cache_dir), "deezer")
        self.blobs = BlobCache(Path(cache_dir), "covers")
        self.session = session or requests.Session()
        self.session.headers.setdefault("User-Agent", USER_AGENT)
        self.caa_limiter = RateLimiter(1_000_000, 1.0, min_interval=CAA_MIN_INTERVAL)
        self.deezer_limiter = RateLimiter(DEEZER_LIMIT, DEEZER_WINDOW)
        self.counts = {SOURCE_CAA: 0, SOURCE_DEEZER: 0, SOURCE_NONE: 0}
        self.network_requests = 0

    # -- low level --------------------------------------------------------
    def _download(self, url: str, limiter: RateLimiter | None) -> bytes | None:
        """Fetch image bytes, cached. An empty cached blob means 'known absent'."""
        if self.blobs.has(url):
            return self.blobs.get(url)
        if self.offline:
            return None
        if limiter:
            limiter.acquire()
        self.network_requests += 1
        try:
            r = self.session.get(url, timeout=45, allow_redirects=True)
        except requests.RequestException:
            return None  # transient: do NOT poison the cache
        if r.status_code == 404:
            self.blobs.put(url, b"")  # a real answer, cached as such
            return None
        if r.status_code != 200 or not r.content:
            return None
        if not (r.headers.get("Content-Type") or "").startswith("image/"):
            self.blobs.put(url, b"")
            return None
        self.blobs.put(url, r.content)
        return r.content

    def _deezer_search(self, query: str, limit: int = 10) -> list[dict]:
        key = f"{DEEZER_SEARCH}?q={query}&limit={limit}"
        if self.json_cache.has(key):
            return self.json_cache.get(key) or []
        if self.offline:
            return []
        self.deezer_limiter.acquire()
        self.network_requests += 1
        try:
            r = self.session.get(DEEZER_SEARCH, params={"q": query, "limit": limit},
                                 timeout=30)
        except requests.RequestException:
            return []
        if r.status_code != 200:
            return []
        try:
            payload = r.json()
        except ValueError:
            return []
        if isinstance(payload, dict) and payload.get("error"):
            return []
        data = (payload or {}).get("data") or []
        self.json_cache.put(key, data)
        return data

    # -- sources ----------------------------------------------------------
    def caa_url(self, mbid: str) -> str:
        return f"{CAA_BASE}/release/{mbid}/front-500"

    def from_caa(self, mbid: str) -> Artwork:
        url = self.caa_url(mbid)
        data = self._download(url, self.caa_limiter)
        if data:
            return Artwork(url, SOURCE_CAA, None, data)
        return Artwork(None, SOURCE_NONE, "caa_absent")

    def from_deezer(self, artist: str, album: str,
                    track_count: int | None = None) -> Artwork:
        queries = [
            f'artist:"{_q(artist)}" album:"{_q(album)}"',
            f"{_q(artist)} {_q(album)}",
        ]
        for query in queries:
            cands = self._deezer_search(query)
            pick = pick_deezer_album(artist, album, cands, track_count)
            if not pick:
                continue
            url = deezer_cover_url(pick)
            if not url:
                continue
            data = self._download(url, self.deezer_limiter)
            if data:
                return Artwork(url, SOURCE_DEEZER, None, data)
        return Artwork(None, SOURCE_NONE, "deezer_no_match")

    # -- public -----------------------------------------------------------
    def resolve(self, mbid: str | None, artist: str, album: str,
                caa_front: bool | None = None,
                track_count: int | None = None,
                record: bool = True) -> Artwork:
        """Resolve one album's cover.

        ``caa_front`` is MusicBrainz's own ``cover-art-archive.front`` flag. It
        comes free with the release fetch, so when it is explicitly False we
        skip the CAA request entirely and go straight to Deezer.
        """
        art = Artwork(None, SOURCE_NONE, "no_mbid")
        if mbid and caa_front is not False:
            art = self.from_caa(mbid)
        elif mbid:
            art = Artwork(None, SOURCE_NONE, "caa_no_front_flag")

        if not art.found and self.use_deezer:
            art = self.from_deezer(artist, album, track_count)

        if record:
            self.counts[art.source] = self.counts.get(art.source, 0) + 1
        return art

    def prefetch(self, items, workers: int = 8) -> None:
        """Warm the caches for a batch of albums, concurrently.

        Nothing is returned: every lookup and every downloaded image lands in
        the on-disk caches, so the caller's ordinary sequential pass over the
        same albums afterwards is all cache hits and costs no network. The
        rate limiters still gate how fast requests *start*; what overlaps is
        the transfer time, which is where the wall clock actually goes (a
        Cover Art Archive fetch redirects to archive.org and takes ~1.5-3s).

        Safe to skip entirely — it is a pure optimisation.
        """
        items = [i for i in items if i]
        if self.offline or not items or workers <= 1:
            return

        def one(item):
            mbid, artist, album, caa_front, track_count = item
            try:
                self.resolve(mbid, artist, album, caa_front, track_count, record=False)
            except Exception:  # pragma: no cover - a warm-up must never fail a run
                pass

        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(one, items))

    def image_for(self, url: str | None) -> bytes | None:
        """Bytes for an already-known cover URL (cached; no re-download if warm)."""
        if not url:
            return None
        limiter = self.deezer_limiter if "dzcdn" in url or "deezer" in url else self.caa_limiter
        return self._download(url, limiter)


def _q(s: str) -> str:
    """Strip characters Deezer's advanced-query parser treats as syntax."""
    for ch in ['"', "\\", ":", "(", ")", "[", "]", "{", "}"]:
        s = s.replace(ch, " ")
    return " ".join(s.split())
