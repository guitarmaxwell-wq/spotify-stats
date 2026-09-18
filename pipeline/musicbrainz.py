"""Rate-limited, disk-cached MusicBrainz web-service client.

MusicBrainz allows 1 request/second per client and requires a descriptive
User-Agent with contact info. Both are enforced here, not left to callers.
Every response (including negative ones) is cached to ``pipeline/.cache`` so a
rerun costs no network at all.
"""

from __future__ import annotations

import hashlib
import json
import time
import urllib.parse
from pathlib import Path

import requests

USER_AGENT = "CratesApp/0.1 ( https://github.com/guitarmaxwell-wq/spotify-stats )"
BASE = "https://musicbrainz.org/ws/2"
CACHE_DIR = Path(__file__).with_name(".cache")
MIN_INTERVAL = 1.05  # seconds between live requests


class MusicBrainzClient:
    def __init__(self, cache_dir: Path = CACHE_DIR, offline: bool = False):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.offline = offline
        self._last_request = 0.0
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
        self.hits = 0
        self.misses = 0
        self.errors = 0

    # -- cache ------------------------------------------------------------
    def _cache_path(self, url: str) -> Path:
        h = hashlib.sha1(url.encode("utf-8")).hexdigest()
        sub = self.cache_dir / h[:2]
        sub.mkdir(parents=True, exist_ok=True)
        return sub / f"{h}.json"

    def _throttle(self) -> None:
        wait = MIN_INTERVAL - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)
        self._last_request = time.monotonic()

    def get(self, path: str, params: dict | None = None) -> dict | None:
        params = dict(params or {})
        params.setdefault("fmt", "json")
        url = f"{BASE}/{path.lstrip('/')}?{urllib.parse.urlencode(sorted(params.items()))}"
        cp = self._cache_path(url)
        if cp.exists():
            self.hits += 1
            try:
                payload = json.loads(cp.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                cp.unlink(missing_ok=True)
            else:
                return payload.get("data")
        if self.offline:
            return None

        self.misses += 1
        data = self._fetch(url)
        cp.write_text(json.dumps({"url": url, "data": data}), encoding="utf-8")
        return data

    def _fetch(self, url: str, attempts: int = 4) -> dict | None:
        for attempt in range(attempts):
            self._throttle()
            try:
                r = self.session.get(url, timeout=30)
            except requests.RequestException:
                time.sleep(2 * (attempt + 1))
                continue
            if r.status_code == 200:
                try:
                    return r.json()
                except ValueError:
                    return None
            if r.status_code == 404:
                return None  # cached as a hard negative
            if r.status_code in (429, 503):
                time.sleep(2 * (attempt + 1))
                continue
            time.sleep(1 + attempt)
        self.errors += 1
        return None

    # -- endpoints --------------------------------------------------------
    def release(self, mbid: str) -> dict | None:
        return self.get(
            f"release/{mbid}",
            {"inc": "recordings+artist-credits+release-groups+tags+genres"},
        )

    def release_group(self, mbid: str) -> dict | None:
        return self.get(f"release-group/{mbid}", {"inc": "tags+genres"})

    def artist(self, mbid: str) -> dict | None:
        return self.get(f"artist/{mbid}", {"inc": "tags+genres"})

    def search_release(self, artist: str, album: str, limit: int = 8) -> list[dict]:
        query = f'artist:"{_esc(artist)}" AND release:"{_esc(album)}"'
        data = self.get("release", {"query": query, "limit": limit})
        return (data or {}).get("releases", []) or []

    def search_release_loose(self, artist: str, album: str, limit: int = 8) -> list[dict]:
        query = f'artist:"{_esc(artist)}" AND release:({_esc(album)})'
        data = self.get("release", {"query": query, "limit": limit})
        return (data or {}).get("releases", []) or []


def _esc(s: str) -> str:
    for ch in ['\\', '"', "+", "-", "!", "(", ")", "{", "}", "[", "]", "^", "~", "*", "?", ":", "/"]:
        s = s.replace(ch, " ")
    return " ".join(s.split())
