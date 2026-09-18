"""The source interface, plus a rate-limited JSON transport.

Every source implements :class:`PlaySource`. The two network sources take a
``transport`` callable so their paging and cursor logic can be tested without a
socket — which is the only part of them worth testing, and the part that
silently loses a user's plays when it is wrong.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Protocol

from ..schema import IngestResult
from ..store import PlayStore

#: ``(url, headers) -> parsed JSON``.
Transport = Callable[[str, dict], dict]

USER_AGENT = "Crates/0.1 (listening-history ingest; https://github.com/guitarmaxwell-wq)"


class SourceError(RuntimeError):
    """A source could not complete a sync. Carries a user-showable message."""


class AuthRequired(SourceError):
    """The source needs credentials the caller has not supplied."""


class RateLimited(SourceError):
    def __init__(self, retry_after: int = 1):
        super().__init__(f"rate limited, retry in {retry_after}s")
        self.retry_after = retry_after


class PlaySource(Protocol):
    name: str

    def sync(self, store: PlayStore) -> IngestResult:
        """Fetch what is new, add it to the store, advance the cursor."""
        ...


class HttpTransport:
    """Minimal JSON GET with a rate limit and bounded retries.

    Last.fm asks for roughly one request per second; Spotify returns 429 with a
    ``Retry-After``. Both are handled here so the source modules stay readable.
    """

    def __init__(self, min_interval: float = 0.25, max_retries: int = 4,
                 timeout: float = 20.0, sleep=time.sleep):
        self.min_interval = min_interval
        self.max_retries = max_retries
        self.timeout = timeout
        self._sleep = sleep
        self._last_call = 0.0
        self.requests = 0

    def __call__(self, url: str, headers: dict | None = None) -> dict:
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})}
        for attempt in range(self.max_retries + 1):
            gap = self.min_interval - (time.monotonic() - self._last_call)
            if gap > 0:
                self._sleep(gap)
            req = urllib.request.Request(url, headers=headers)
            try:
                self.requests += 1
                self._last_call = time.monotonic()
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                if exc.code == 401:
                    raise AuthRequired("credentials rejected (401)") from exc
                if exc.code == 429 and attempt < self.max_retries:
                    retry_after = int(exc.headers.get("Retry-After") or 1)
                    self._sleep(min(retry_after, 60))
                    continue
                if 500 <= exc.code < 600 and attempt < self.max_retries:
                    self._sleep(2 ** attempt)
                    continue
                raise SourceError(f"HTTP {exc.code} from {_host(url)}") from exc
            except urllib.error.URLError as exc:
                if attempt < self.max_retries:
                    self._sleep(2 ** attempt)
                    continue
                raise SourceError(f"could not reach {_host(url)}: {exc.reason}") from exc
        raise SourceError(f"gave up on {_host(url)}")


def _host(url: str) -> str:
    return urllib.parse.urlsplit(url).netloc or url


def build_url(base: str, params: dict) -> str:
    clean = {k: v for k, v in params.items() if v not in (None, "", 0)}
    return f"{base}?{urllib.parse.urlencode(clean)}"


def collect(source_name: str, store: PlayStore, events, *, invalid: int = 0,
            skipped: int = 0, fetched: int | None = None, last_ts: int = 0,
            gap: bool = False, advance: bool = True, warnings=None) -> IngestResult:
    """Shared tail end of a sync: dedupe, persist, advance, report.

    ``advance=False`` persists the events but leaves the cursor alone. Sources
    that page **newest-first** (Last.fm) must use it for every page but the
    last: advancing on page 1 would record "caught up to now" while the older
    pages are still unfetched, and an interrupt there would skip them forever.
    Sources that page oldest-first (Spotify's ``after`` cursor) can advance as
    they go, because everything behind the mark really is in the store.
    """
    events = list(events)
    accepted, dupes = store.extend(events)
    if advance:
        added = store.commit(source_name, accepted, last_ts=last_ts,
                             synced_at=int(time.time()), gap=gap)
    else:
        added = store.append_to_disk(accepted)
    return IngestResult(
        source=source_name,
        fetched=len(events) if fetched is None else fetched,
        added=added,
        duplicates=dupes,
        invalid=invalid,
        skipped=skipped,
        cursor=store.cursor(source_name).to_dict(),
        warnings=list(warnings or []),
    )
