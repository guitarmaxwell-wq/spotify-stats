"""Small on-disk HTTP caches shared by the enrichment clients.

This is the *raw response* layer that has always lived under
``pipeline/.cache/``: sharded by SHA-1 prefix so a directory never holds tens
of thousands of entries. The structured, queryable album store
(``pipeline/album_cache.py``) sits on top of this, not instead of it — this
layer is what makes a cold rerun free, including negative answers.

Two flavours:

* :class:`JsonCache` — JSON payloads (Deezer search results, CAA lookups).
  A cached ``None`` is a real answer ("upstream has nothing"), not a miss, so
  404s are never re-fetched.
* :class:`BlobCache` — bytes (cover images), kept so colour extraction never
  re-downloads a sleeve it has already seen.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

CACHE_DIR = Path(__file__).with_name(".cache")


def _shard(root: Path, key: str, suffix: str) -> Path:
    h = hashlib.sha1(key.encode("utf-8")).hexdigest()
    sub = root / h[:2]
    sub.mkdir(parents=True, exist_ok=True)
    return sub / f"{h}{suffix}"


class JsonCache:
    """Cache of JSON payloads keyed by an arbitrary string (usually a URL)."""

    def __init__(self, root: Path, namespace: str = ""):
        self.root = Path(root) / namespace if namespace else Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.hits = 0
        self.misses = 0

    def _path(self, key: str) -> Path:
        return _shard(self.root, key, ".json")

    def has(self, key: str) -> bool:
        return self._path(key).exists()

    def get(self, key: str, default=None):
        p = self._path(key)
        if not p.exists():
            self.misses += 1
            return default
        try:
            payload = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            p.unlink(missing_ok=True)
            self.misses += 1
            return default
        self.hits += 1
        return payload.get("data")

    def put(self, key: str, data) -> None:
        self._path(key).write_text(
            json.dumps({"key": key, "data": data}, ensure_ascii=False), encoding="utf-8"
        )


class BlobCache:
    """Cache of raw bytes (cover images) keyed by URL."""

    def __init__(self, root: Path, namespace: str = "blobs"):
        self.root = Path(root) / namespace if namespace else Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.hits = 0
        self.misses = 0

    def _path(self, key: str) -> Path:
        return _shard(self.root, key, ".bin")

    def has(self, key: str) -> bool:
        return self._path(key).exists()

    def get(self, key: str) -> bytes | None:
        p = self._path(key)
        if not p.exists():
            self.misses += 1
            return None
        self.hits += 1
        try:
            data = p.read_bytes()
        except OSError:
            return None
        # A zero-length blob is the cached form of "this URL has no image".
        return data or None

    def put(self, key: str, data: bytes | None) -> None:
        self._path(key).write_bytes(data or b"")
