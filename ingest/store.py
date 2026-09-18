"""Append-only play store with per-source cursors.

Two files, both under ``data/``:

* ``plays.jsonl``  -- one :class:`~ingest.schema.PlayEvent` per line.
* ``ingest_state.json`` -- per-source cursors (the high-water marks) plus
  counters. Kept separate so a corrupted cursor never costs you the plays.

The store is append-only on disk and de-duplicating in memory. Appending means
an interrupted sync loses at most the events it had not flushed, never the
history; it also means you can ``tail -f`` it while a backfill runs.

De-duplication is the interesting part. A user with Spotify *and* Last.fm linked
produces two records of every play, with timestamps up to a track-length apart
(Last.fm stamps the start, Spotify the end). So:

* Within one source, only an exact ``(identity, ts)`` repeat is a duplicate.
  Sources do not emit the same play twice with different timestamps, and
  collapsing near-identical timestamps would silently eat a track played twice
  on repeat.
* Across sources, the same ``(artist_key, track_key)`` within a tolerance window
  is one play. The window widens to the track's duration when we know it.
"""

from __future__ import annotations

import bisect
import json
import os
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

from .schema import InvalidPlayEvent, PlayEvent, Source

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PLAYS = ROOT / "data" / "plays.jsonl"
DEFAULT_STATE = ROOT / "data" / "ingest_state.json"

#: Cross-source dedupe window. A play recorded by Last.fm at its start and by
#: Spotify at its end differs by the track's length; 4 minutes covers the great
#: majority of tracks, and anything longer gets the duration-aware window below.
CROSS_SOURCE_TOLERANCE_S = 240


@dataclass
class Cursor:
    """A source's high-water mark.

    ``after_ms`` is what Spotify's ``recently-played`` wants (Unix ms);
    ``from_uts`` is what Last.fm's ``user.getRecentTracks`` wants (Unix s).
    Both are derived from the same underlying "newest play we have seen", but
    they are stored as the APIs consume them so a caller never has to remember
    which one is in milliseconds at 2am.
    """

    source: str
    last_ts: int = 0
    last_synced_at: int = 0
    total_added: int = 0
    # Set when a poll came back completely full, meaning plays may have been
    # lost between polls. Surfaced in the UI rather than buried.
    suspected_gaps: int = 0

    @property
    def after_ms(self) -> int:
        return self.last_ts * 1000 if self.last_ts else 0

    @property
    def from_uts(self) -> int:
        # +1 so an incremental fetch does not re-deliver the boundary play.
        return self.last_ts + 1 if self.last_ts else 0

    def to_dict(self) -> dict:
        return {
            "source": self.source,
            "last_ts": self.last_ts,
            "last_synced_at": self.last_synced_at,
            "total_added": self.total_added,
            "suspected_gaps": self.suspected_gaps,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Cursor":
        return cls(
            source=d.get("source", ""),
            last_ts=int(d.get("last_ts") or 0),
            last_synced_at=int(d.get("last_synced_at") or 0),
            total_added=int(d.get("total_added") or 0),
            suspected_gaps=int(d.get("suspected_gaps") or 0),
        )


class PlayStore:
    """All of a user's plays, from every source, de-duplicated."""

    def __init__(self, plays_path=DEFAULT_PLAYS, state_path=DEFAULT_STATE, *,
                 tolerance_s: int = CROSS_SOURCE_TOLERANCE_S):
        self.plays_path = Path(plays_path)
        self.state_path = Path(state_path)
        self.tolerance_s = tolerance_s
        self.events: list[PlayEvent] = []
        self.cursors: dict[str, Cursor] = {}
        self._index: dict[tuple[str, str], list[int]] = defaultdict(list)
        self._exact: set[tuple[str, str, str, int]] = set()
        self.corrupt_lines = 0

    # ------------------------------------------------------------- loading --

    def load(self) -> "PlayStore":
        if self.plays_path.exists():
            with open(self.plays_path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = PlayEvent.from_dict(json.loads(line))
                    except (json.JSONDecodeError, InvalidPlayEvent):
                        # A half-written last line after a hard kill. Skip it
                        # and keep the rest; that is the point of JSONL.
                        self.corrupt_lines += 1
                        continue
                    self._remember(ev)
                    self.events.append(ev)

        if self.state_path.exists():
            try:
                raw = json.loads(self.state_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                raw = {}
            for name, d in (raw.get("cursors") or {}).items():
                self.cursors[name] = Cursor.from_dict({**d, "source": name})
        return self

    def cursor(self, source: str) -> Cursor:
        return self.cursors.setdefault(source, Cursor(source=source))

    # ------------------------------------------------------------- dedupe ---

    def _window(self, ev: PlayEvent) -> int:
        if ev.duration_ms:
            return max(self.tolerance_s, ev.duration_ms // 1000 + 60)
        return self.tolerance_s

    def _remember(self, ev: PlayEvent) -> None:
        bisect.insort(self._index[ev.identity], ev.ts)
        self._exact.add((ev.source, *ev.identity, ev.ts))

    def is_duplicate(self, ev: PlayEvent) -> bool:
        if (ev.source, *ev.identity, ev.ts) in self._exact:
            return True
        stamps = self._index.get(ev.identity)
        if not stamps:
            return False
        window = self._window(ev)
        i = bisect.bisect_left(stamps, ev.ts - window)
        while i < len(stamps) and stamps[i] <= ev.ts + window:
            # Only cross-source events collapse; see the module docstring.
            if (ev.source, *ev.identity, stamps[i]) not in self._exact:
                return True
            i += 1
        return False

    # ------------------------------------------------------------- writing --

    def add(self, ev: PlayEvent) -> bool:
        """Add one event. Returns False if it was a duplicate."""
        if self.is_duplicate(ev):
            return False
        self._remember(ev)
        self.events.append(ev)
        return True

    def extend(self, events) -> tuple[list[PlayEvent], int]:
        """Add many. Returns (accepted, duplicate_count)."""
        accepted, dupes = [], 0
        for ev in events:
            if self.add(ev):
                accepted.append(ev)
            else:
                dupes += 1
        return accepted, dupes

    def append_to_disk(self, events) -> int:
        """Append accepted events to plays.jsonl. Call after :meth:`extend`."""
        events = list(events)
        if not events:
            return 0
        self.plays_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.plays_path, "a", encoding="utf-8") as fh:
            for ev in events:
                fh.write(ev.to_json() + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        return len(events)

    def advance_cursor(self, source: str, *, last_ts: int, added: int = 0,
                       synced_at: int = 0, gap: bool = False) -> Cursor:
        """Move a source's high-water mark forward. Never backward.

        Monotonicity is the whole point: a poll that returns nothing, or an
        import of ancient history, must not rewind the mark and cause the next
        incremental fetch to re-walk everything.
        """
        cur = self.cursor(source)
        cur.last_ts = max(cur.last_ts, int(last_ts or 0))
        cur.total_added += added
        if synced_at:
            cur.last_synced_at = int(synced_at)
        if gap:
            cur.suspected_gaps += 1
        return cur

    def save_state(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        doc = {
            "version": 1,
            "event_count": len(self.events),
            "cursors": {name: c.to_dict() for name, c in sorted(self.cursors.items())},
        }
        tmp = self.state_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(doc, indent=2), encoding="utf-8")
        tmp.replace(self.state_path)

    def commit(self, source: str, accepted, *, last_ts: int = 0, synced_at: int = 0,
               gap: bool = False) -> int:
        """Persist accepted events, then advance the cursor, then save state.

        Order matters. If we crash between the append and the cursor write we
        re-fetch a few plays and de-dupe them; if we did it the other way round
        we would lose them.
        """
        accepted = list(accepted)
        n = self.append_to_disk(accepted)
        high = max([ev.ts for ev in accepted], default=0)
        self.advance_cursor(source, last_ts=max(last_ts, high), added=n,
                            synced_at=synced_at, gap=gap)
        self.save_state()
        return n

    # ------------------------------------------------------------- reading --

    def stats(self) -> dict:
        by_source = Counter(ev.source for ev in self.events)
        stamps = [ev.ts for ev in self.events]
        return {
            "total_plays": len(self.events),
            "by_source": dict(by_source),
            "first_ts": min(stamps) if stamps else 0,
            "last_ts": max(stamps) if stamps else 0,
            "corrupt_lines": self.corrupt_lines,
        }
