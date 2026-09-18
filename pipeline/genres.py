"""Map raw MusicBrainz tags/genres onto the small controlled crate vocabulary."""

from __future__ import annotations

import re
from pathlib import Path

import yaml

MAP_PATH = Path(__file__).with_name("genre_map.yaml")


class GenreMapper:
    def __init__(self, path: Path = MAP_PATH):
        cfg = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        self.fallback = cfg.get("fallback", "other")
        self.crates = cfg["crates"]
        self.labels = {c["id"]: c["label"] for c in self.crates}
        self.order = [c["id"] for c in self.crates]
        self._terms = {
            c["id"]: sorted({str(t).lower().strip() for t in (c.get("match") or [])},
                            key=len, reverse=True)
            for c in self.crates
        }
        self._patterns = {
            cid: [(t, re.compile(r"(?<!\w)" + re.escape(t) + r"(?!\w)")) for t in terms]
            for cid, terms in self._terms.items()
        }

    def classify(self, tags: list[tuple[str, int]]) -> tuple[str, list[str]]:
        """tags is [(tag_name, vote_count)]. Returns (crate_id, matched_tags)."""
        scores: dict[str, float] = {}
        evidence: dict[str, list[str]] = {}
        for raw, count in tags:
            tag = str(raw).lower().strip()
            if not tag:
                continue
            weight = max(1, int(count or 1))
            for cid in self.order:
                for term, pat in self._patterns[cid]:
                    if tag == term or pat.search(tag):
                        # Longer, more specific terms score higher.
                        scores[cid] = scores.get(cid, 0) + weight * (1 + len(term) / 40)
                        evidence.setdefault(cid, []).append(tag)
                        break
        if not scores:
            return self.fallback, []
        best = max(scores.items(), key=lambda kv: (kv[1], -self.order.index(kv[0])))[0]
        return best, sorted(set(evidence.get(best, [])))


def extract_tags(*entities: dict | None) -> list[tuple[str, int]]:
    """Pull (name, count) pairs out of MB entities' `genres` and `tags` arrays.

    `genres` (curated) are weighted above free-form `tags`.
    """
    out: list[tuple[str, int]] = []
    for ent in entities:
        if not ent:
            continue
        for g in ent.get("genres") or []:
            out.append((g.get("name", ""), int(g.get("count") or 1) * 3 + 3))
        for t in ent.get("tags") or []:
            out.append((t.get("name", ""), int(t.get("count") or 1)))
    return [(n, c) for n, c in out if n]
