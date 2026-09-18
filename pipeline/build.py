"""Entry point: python -m pipeline.build

Turns data/scrobbles.csv into data/collection.json using MusicBrainz for
canonical tracklists and genres.

Because MusicBrainz is capped at 1 request/second, every response is cached on
disk and the run is resumable: re-running after an interrupt replays the cache
and only fetches what is genuinely new. Groups are processed most-tracks-first
so a usable collection.json exists within minutes.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .completion import build_matching, summarize
from .genres import GenreMapper, extract_tags
from .musicbrainz import MusicBrainzClient
from .normalize import slugify
from .resolve import resolve_group
from .scrobbles import AlbumGroup, iso, load_groups

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CSV = ROOT / "data" / "scrobbles.csv"
DEFAULT_OUT = ROOT / "data" / "collection.json"


def _release_year(release: dict) -> int | None:
    for key in ("date",):
        d = release.get(key)
        if d and len(d) >= 4 and d[:4].isdigit():
            return int(d[:4])
    rg = release.get("release-group") or {}
    d = rg.get("first-release-date")
    if d and len(d) >= 4 and d[:4].isdigit():
        return int(d[:4])
    return None


def _cover_url(release: dict) -> str | None:
    caa = release.get("cover-art-archive") or {}
    if caa.get("front") and release.get("id"):
        return f"https://coverartarchive.org/release/{release['id']}/front-500"
    return None


def _classify(release: dict, mb: MusicBrainzClient, mapper: GenreMapper,
              allow_extra: bool) -> tuple[str, list[str]]:
    """Classify progressively, cheapest source first.

    The release's own tags come free with the release fetch. Only when they
    fail to hit the crate vocabulary do we spend extra rate-limited requests on
    the release group and then the artist (the latter is shared across all of
    that artist's albums, so it is nearly free after the first hit).
    """
    tags = extract_tags(release)
    genre_id, evidence = mapper.classify(tags)
    if genre_id != mapper.fallback or not allow_extra:
        return genre_id, evidence

    rg = release.get("release-group") or {}
    if rg.get("id"):
        tags += extract_tags(mb.release_group(rg["id"]))
        genre_id, evidence = mapper.classify(tags)
        if genre_id != mapper.fallback:
            return genre_id, evidence

    for credit in release.get("artist-credit") or []:
        artist_mbid = (credit.get("artist") or {}).get("id")
        if artist_mbid:
            tags += [(n, max(1, c // 2)) for n, c in extract_tags(mb.artist(artist_mbid))]
            break
    return mapper.classify(tags)


def build_album(group: AlbumGroup, res, mb: MusicBrainzClient, mapper: GenreMapper,
                fetch_genres: bool) -> dict:
    release = res.release
    matches = build_matching(res.tracklist, group.tracks.keys())
    first_uts = {k: t.first_uts for k, t in group.tracks.items()}
    summary = summarize(matches, first_uts)

    genre_id, evidence = _classify(release, mb, mapper, fetch_genres)

    unlocked_at = iso(summary["unlocked_uts"]) if summary["unlocked_uts"] else None
    return {
        "id": release.get("id") or slugify(group.artist, group.album),
        "artist": group.artist,
        "title": group.album,
        "release_year": _release_year(release),
        "genre_id": genre_id,
        "cover_url": _cover_url(release),
        "total_tracks": summary["total_tracks"],
        "played_tracks": summary["played_tracks"],
        "completion": summary["completion"],
        "unlocked": summary["unlocked"],
        "unlocked_at": unlocked_at,
        "play_count": group.play_count,
        "missing_tracks": summary["missing_tracks"],
        "source": res.source,
        # Diagnostics — not part of the contract, safe for the app to ignore.
        "_fuzzy_matches": summary["fuzzy_matches"],
        "_genre_tags": evidence[:6],
    }


def write_collection(path: Path, stats: dict, albums: list[dict], unresolved: list[dict],
                     mapper: GenreMapper, partial: bool) -> None:
    counts = Counter(a["genre_id"] for a in albums)
    genres = [
        {"id": cid, "label": mapper.labels[cid], "album_count": counts.get(cid, 0)}
        for cid in mapper.order
        if counts.get(cid, 0) or cid == mapper.fallback
    ]
    albums_sorted = sorted(
        albums, key=lambda a: (not a["unlocked"], -a["completion"], -a["play_count"])
    )
    doc = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stats": {
            "total_plays": stats["total_plays"],
            "distinct_artists": stats["distinct_artists"],
            "first_play": stats["first_play"],
            "last_play": stats["last_play"],
            "unlocked_count": sum(1 for a in albums if a["unlocked"]),
            "in_progress_count": sum(1 for a in albums if not a["unlocked"]),
            "resolved_count": len(albums),
            "unresolved_count": len(unresolved),
            "album_groups_total": stats["group_count"],
            "partial": partial,
        },
        "genres": genres,
        "albums": albums_sorted,
        "unresolved": sorted(unresolved, key=lambda u: -u["play_count"]),
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m pipeline.build")
    p.add_argument("--csv", default=str(DEFAULT_CSV))
    p.add_argument("--out", default=str(DEFAULT_OUT))
    p.add_argument("--limit", type=int, default=None, help="only process the first N groups")
    p.add_argument("--min-tracks", type=int, default=1,
                   help="skip groups with fewer distinct played tracks (default 1)")
    p.add_argument("--offline", action="store_true",
                   help="cache only; never hit the network (fast re-bucketing)")
    p.add_argument("--no-genre-lookups", action="store_true",
                   help="use release tags only; skip release-group/artist tag requests")
    p.add_argument("--checkpoint-every", type=int, default=25)
    args = p.parse_args(argv)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    print(f"loading {args.csv} ...", file=sys.stderr)
    groups, stats = load_groups(args.csv)
    work = [g for g in groups if g.distinct_tracks >= args.min_tracks]
    if args.limit:
        work = work[: args.limit]
    print(f"{stats['group_count']} groups; processing {len(work)}", file=sys.stderr)

    mb = MusicBrainzClient(offline=args.offline)
    mapper = GenreMapper()

    albums: list[dict] = []
    unresolved: list[dict] = []
    started = time.time()

    for i, g in enumerate(work, 1):
        try:
            res = resolve_group(g, mb)
        except Exception as exc:  # pragma: no cover - network defensive
            res = None
            print(f"  ! {g.artist} - {g.album}: {exc}", file=sys.stderr)
        if not res or not res.release or not res.tracklist:
            unresolved.append({
                "artist": g.artist,
                "album": g.album,
                "reason": (res.reason if res else "error") or "no_mb_match",
                "play_count": g.play_count,
            })
        else:
            albums.append(
                build_album(g, res, mb, mapper, fetch_genres=not args.no_genre_lookups)
            )

        if i % args.checkpoint_every == 0 or i == len(work):
            write_collection(out, stats, albums, unresolved, mapper, partial=i < len(work))
            rate = i / max(time.time() - started, 1e-6)
            unlocked = sum(1 for a in albums if a["unlocked"])
            print(
                f"  [{i}/{len(work)}] resolved={len(albums)} unlocked={unlocked} "
                f"unresolved={len(unresolved)} cache_hit={mb.hits} net={mb.misses} "
                f"{rate:.2f} groups/s",
                file=sys.stderr,
                flush=True,
            )

    write_collection(out, stats, albums, unresolved, mapper, partial=False)
    print(f"wrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
