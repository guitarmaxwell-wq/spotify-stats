"""Entry point: python -m pipeline.build

Turns data/scrobbles.csv into data/collection.json using MusicBrainz for
canonical tracklists and genres.

Because MusicBrainz is capped at 1 request/second, every response is cached on
disk and the run is resumable: re-running after an interrupt replays the cache
and only fetches what is genuinely new. Groups are processed most-tracks-first
so a usable collection.json exists within minutes.

Artwork and gradient colours ride along the same way: covers come from the
Cover Art Archive with Deezer as a fallback (never Spotify — see
``docs/CATALOG.md``), and both the URL and the extracted colours are kept in
the structured album cache so a rerun, or a second user with the same album,
costs nothing.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .album_cache import DEFAULT_DB, DEFAULT_TTL_DAYS, AlbumCache, AlbumRecord
from .artwork import SOURCE_NONE, ArtworkResolver
from .colors import extract_colors, fallback_pair
from .completion import build_matching, summarize
from .genres import GenreMapper, extract_tags
from .musicbrainz import MusicBrainzClient
from .normalize import clean_artist, clean_title, slugify
from .resolve import credit_name, resolve_group
from .scrobbles import AlbumGroup, iso, load_groups, merge_group

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CSV = ROOT / "data" / "scrobbles.csv"
DEFAULT_OUT = ROOT / "data" / "collection.json"

#: How many groups are resolved before their covers are warmed as a batch.
PREFETCH_CHUNK = 48


def _chunks(seq, size):
    for start in range(0, len(seq), size):
        yield seq[start: start + size]


def _cached_fresh(cache, mbid, ttl_days) -> bool:
    """True when the album store already answers for this MBID — skip warming."""
    if not cache or not mbid:
        return False
    rec = cache.get(mbid, ttl_days)
    return bool(rec and rec.artwork_source)


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


def _caa_front_flag(release: dict) -> bool | None:
    """MusicBrainz's own "does CAA hold a front cover" flag, or None if absent.

    It rides along with the release fetch for free, so an explicit False lets
    the artwork resolver skip the Cover Art Archive request entirely and go
    straight to the Deezer fallback.
    """
    caa = release.get("cover-art-archive")
    if not isinstance(caa, dict) or "front" not in caa:
        return None
    return bool(caa.get("front"))


def resolve_artwork(mbid: str | None, artist: str, title: str, release: dict,
                    resolver: ArtworkResolver | None, cache: AlbumCache | None,
                    ttl_days: int, with_colors: bool = True,
                    tracklist: list[str] | None = None,
                    genre_tags: list | None = None, genre_id: str | None = None,
                    release_year: int | None = None,
                    refresh_colors: bool = False) -> dict:
    """Artwork URL + source + gradient colours for one album, cache-first.

    The structured cache (`pipeline/album_cache.py`) is consulted before any
    network call and is written back afterwards, so a rerun — or a second user
    who played the same album — costs nothing. A cached row past its TTL is
    re-resolved.

    ``refresh_colors`` ignores the cached colour columns and re-derives them.
    The colour rules are the kind of thing that gets tuned after seeing them on
    a real screen, and the sleeves are already in the blob cache, so a recolour
    pass costs no network at all.
    """
    cached = cache.get(mbid, ttl_days) if (cache and mbid) else None
    if cached and cached.artwork_source and not (refresh_colors and with_colors):
        if cached.artwork_source == SOURCE_NONE or cached.colors or not with_colors:
            return _finish({
                "cover_url": cached.artwork_url,
                "artwork_source": cached.artwork_source,
                "colors": cached.colors,
                "color_strategy": cached.color_strategy,
                "_from_cache": True,
            }, with_colors)

    if resolver is None:
        stored = cache.peek(mbid) if (cache and mbid) else None
        return _finish({
            "cover_url": stored.artwork_url if stored else None,
            "artwork_source": stored.artwork_source if stored else None,
            "colors": stored.colors if stored else None,
            "color_strategy": stored.color_strategy if stored else None,
            "_from_cache": True,
        }, with_colors)

    art = resolver.resolve(
        mbid, artist, title,
        caa_front=_caa_front_flag(release),
        track_count=len(tracklist or []) or None,
    )

    colors = None
    strategy = None
    if with_colors and art.found:
        data = art.image or resolver.image_for(art.url)
        pair = extract_colors(data)
        colors = pair.as_dict()
        strategy = pair.strategy

    # An offline run has no way to tell "upstream has nothing" from "we could
    # not ask", so never let it write a negative artwork result into the store.
    negative_offline = resolver.offline and art.source == SOURCE_NONE
    if cache and mbid and not negative_offline:
        cache.put(AlbumRecord(
            mbid=mbid, artist=artist, title=title, release_year=release_year,
            tracklist=list(tracklist or []), genre_tags=list(genre_tags or []),
            genre_id=genre_id,
            artwork_url=art.url, artwork_source=art.source,
            color_primary=(colors or {}).get("primary"),
            color_secondary=(colors or {}).get("secondary"),
            color_strategy=strategy,
        ))

    return _finish({
        "cover_url": art.url,
        "artwork_source": art.source,
        "colors": colors,
        "color_strategy": strategy,
        "_from_cache": False,
    }, with_colors)


def _finish(out: dict, with_colors: bool) -> dict:
    """Guarantee the app always has a usable gradient pair.

    An album with no artwork anywhere has no colours to extract, but the
    progress bar still has to render, so it gets the neutral fallback pair —
    which goes through the same contrast and separation rules as every other
    pair. ``color_strategy == "neutral-fallback"`` marks it. Only the JSON gets
    this; the album cache keeps honest NULLs, so a later run that *does* find
    artwork is not fooled into thinking colours were already extracted.
    """
    if with_colors and not out.get("colors"):
        pair = fallback_pair()
        out["colors"] = pair.as_dict()
        out["color_strategy"] = pair.strategy
    return out


def use_release_display(album: dict, release: dict) -> dict:
    """Name a merged record after the release itself, not one of the scrobbles.

    Two groups that merged disagreed about the spelling by definition (that is
    *why* they were two groups), so "Cordae" vs "YBN Cordae" has to be decided
    by something other than which one was seen first. MusicBrainz's own artist
    credit and release title are the tiebreaker.
    """
    artist = clean_artist(credit_name(release))
    title = clean_title(release.get("title") or "")
    if artist:
        album["artist"] = artist
    if title:
        album["title"] = title
    return album


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
                fetch_genres: bool, resolver: ArtworkResolver | None = None,
                cache: AlbumCache | None = None, ttl_days: int = DEFAULT_TTL_DAYS,
                with_colors: bool = True, refresh_colors: bool = False) -> dict:
    release = res.release
    matches = build_matching(res.tracklist, group.tracks.keys())
    first_uts = {k: t.first_uts for k, t in group.tracks.items()}
    summary = summarize(matches, first_uts)

    genre_id, evidence = _classify(release, mb, mapper, fetch_genres)
    release_year = _release_year(release)

    art = resolve_artwork(
        release.get("id"), group.artist, group.album, release,
        resolver, cache, ttl_days, with_colors,
        tracklist=res.tracklist, genre_tags=evidence, genre_id=genre_id,
        release_year=release_year, refresh_colors=refresh_colors,
    )

    unlocked_at = iso(summary["unlocked_uts"]) if summary["unlocked_uts"] else None
    return {
        "id": release.get("id") or slugify(group.artist, group.album),
        "artist": group.artist,
        "title": group.album,
        "release_year": release_year,
        "genre_id": genre_id,
        "cover_url": art["cover_url"],
        "artwork_source": art["artwork_source"],
        "colors": art["colors"],
        "total_tracks": summary["total_tracks"],
        "played_tracks": summary["played_tracks"],
        "completion": summary["completion"],
        "unlocked": summary["unlocked"],
        "unlocked_at": unlocked_at,
        "play_count": group.play_count,
        "missing_tracks": summary["missing_tracks"],
        "source": res.source,
        # How `colors` was arrived at, so the rules stay auditable per album.
        "color_strategy": art["color_strategy"],
        # Diagnostics — not part of the contract, safe for the app to ignore.
        "_fuzzy_matches": summary["fuzzy_matches"],
        "_genre_tags": evidence[:6],
    }


def assert_unique_ids(albums: list[dict]) -> None:
    """``albums[].id`` is the app's list key and the record's identity.

    A duplicate means two records are really one album whose plays got split,
    which silently undercounts completion — so fail loudly rather than ship it.
    """
    dupes = {aid: n for aid, n in Counter(a["id"] for a in albums).items() if n > 1}
    if dupes:
        detail = ", ".join(
            f"{aid} x{n} ("
            + " | ".join(f"{a['artist']} - {a['title']}" for a in albums if a["id"] == aid)
            + ")"
            for aid, n in list(dupes.items())[:5]
        )
        raise ValueError(f"duplicate album ids in collection.json: {detail}")


def write_collection(path: Path, stats: dict, albums: list[dict], unresolved: list[dict],
                     mapper: GenreMapper, partial: bool) -> None:
    assert_unique_ids(albums)
    counts = Counter(a["genre_id"] for a in albums)
    genres = [
        {"id": cid, "label": mapper.labels[cid], "album_count": counts.get(cid, 0)}
        for cid in mapper.order
        if counts.get(cid, 0) or cid == mapper.fallback
    ]
    albums_sorted = sorted(
        albums, key=lambda a: (not a["unlocked"], -a["completion"], -a["play_count"])
    )
    art_counts = Counter(a.get("artwork_source") or "none" for a in albums)
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
            "merged_groups": stats.get("merged_groups", 0),
            "album_groups_total": stats["group_count"],
            "partial": partial,
            "artwork": {
                "with_cover": sum(1 for a in albums if a.get("cover_url")),
                "coverartarchive": art_counts.get("coverartarchive", 0),
                "deezer": art_counts.get("deezer", 0),
                "missing": art_counts.get("none", 0),
                "with_colors": sum(1 for a in albums if a.get("colors")),
            },
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
    p.add_argument("--artwork-only", action="store_true",
                   help="replay MusicBrainz from cache; spend the network on artwork only")
    p.add_argument("--no-artwork", action="store_true",
                   help="skip artwork resolution entirely (cache-only cover_url/colors)")
    p.add_argument("--no-deezer", action="store_true",
                   help="Cover Art Archive only; skip the Deezer fallback")
    p.add_argument("--no-colors", action="store_true",
                   help="resolve artwork but skip dominant-colour extraction")
    p.add_argument("--recolor", action="store_true",
                   help="re-derive colours from cached artwork (no network); "
                        "use after changing the colour rules")
    p.add_argument("--album-db", default=str(DEFAULT_DB),
                   help=f"structured album cache (default {DEFAULT_DB})")
    p.add_argument("--cache-ttl-days", type=int, default=DEFAULT_TTL_DAYS,
                   help="re-resolve album cache rows older than this; 0 disables the TTL")
    p.add_argument("--artwork-workers", type=int, default=8,
                   help="threads used to pre-warm artwork downloads (1 disables)")
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

    mb = MusicBrainzClient(offline=args.offline or args.artwork_only)
    mapper = GenreMapper()
    cache = AlbumCache(args.album_db)
    resolver = None
    if not args.no_artwork:
        resolver = ArtworkResolver(offline=args.offline, use_deezer=not args.no_deezer)
    ttl_days = args.cache_ttl_days if not args.offline else 0

    albums: list[dict] = []
    unresolved: list[dict] = []
    # Dedup happens *after* resolution as well as before it: two scrobble
    # groups that land on the same release MBID are one record.
    album_index: dict[str, int] = {}
    merged_groups: dict[str, AlbumGroup] = {}
    newly_unlocked: list[dict] = []
    merge_count = 0
    started = time.time()

    def assemble(group: AlbumGroup, res) -> dict:
        return build_album(
            group, res, mb, mapper,
            fetch_genres=not args.no_genre_lookups,
            resolver=resolver, cache=cache, ttl_days=ttl_days,
            with_colors=not args.no_colors, refresh_colors=args.recolor,
        )

    i = 0
    for chunk in _chunks(work, PREFETCH_CHUNK):
        # Resolve the chunk against MusicBrainz first (1 req/s, or free from
        # the cache), then warm every cover in the chunk concurrently, then
        # assemble — so the assembly pass below is all cache hits. Chunking
        # rather than prefetching everything up front keeps the run streaming
        # and resumable exactly as before.
        resolutions = []
        for g in chunk:
            try:
                res = resolve_group(g, mb)
            except Exception as exc:  # pragma: no cover - network defensive
                res = None
                print(f"  ! {g.artist} - {g.album}: {exc}", file=sys.stderr)
            resolutions.append((g, res))

        if resolver is not None:
            resolver.prefetch(
                [
                    (
                        res.release.get("id"), g.artist, g.album,
                        _caa_front_flag(res.release), len(res.tracklist or []) or None,
                    )
                    for g, res in resolutions
                    if res and res.release and res.tracklist
                    and not _cached_fresh(cache, res.release.get("id"), ttl_days)
                ],
                workers=args.artwork_workers,
            )

        for g, res in resolutions:
            i += 1
            if not res or not res.release or not res.tracklist:
                unresolved.append({
                    "artist": g.artist,
                    "album": g.album,
                    "reason": (res.reason if res else "error") or "no_mb_match",
                    "play_count": g.play_count,
                })
            elif res.release.get("id") and res.release["id"] in album_index:
                # Same release reached from a second scrobble group: the two
                # are the same record, so union their plays and recompute
                # completion / unlocked / unlocked_at from the union.
                mbid = res.release["id"]
                idx = album_index[mbid]
                previous = albums[idx]
                merged = assemble(merge_group(merged_groups[mbid], g), res)
                merged["_merged_from"] = previous.get("_merged_from", 1) + 1
                use_release_display(merged, res.release)
                albums[idx] = merged
                merge_count += 1
                if merged["unlocked"] and not previous["unlocked"]:
                    newly_unlocked.append(merged)
                    print(
                        f"  + merge unlocked: {merged['artist']} - {merged['title']} "
                        f"({previous['played_tracks']}/{previous['total_tracks']} -> "
                        f"{merged['played_tracks']}/{merged['total_tracks']})",
                        file=sys.stderr,
                    )
            else:
                albums.append(assemble(g, res))
                if res.release.get("id"):
                    album_index[res.release["id"]] = len(albums) - 1
                    merged_groups[res.release["id"]] = g

            if i % args.checkpoint_every == 0 or i == len(work):
                stats["merged_groups"] = merge_count
                write_collection(out, stats, albums, unresolved, mapper,
                                 partial=i < len(work))
                rate = i / max(time.time() - started, 1e-6)
                unlocked = sum(1 for a in albums if a["unlocked"])
                art = Counter(a.get("artwork_source") or "none" for a in albums)
                print(
                    f"  [{i}/{len(work)}] resolved={len(albums)} unlocked={unlocked} "
                    f"unresolved={len(unresolved)} cache_hit={mb.hits} net={mb.misses} "
                    f"caa={art.get('coverartarchive', 0)} dz={art.get('deezer', 0)} "
                    f"noart={art.get('none', 0)} {rate:.2f} groups/s",
                    file=sys.stderr,
                    flush=True,
                )

    stats["merged_groups"] = merge_count
    write_collection(out, stats, albums, unresolved, mapper, partial=False)
    art = Counter(a.get("artwork_source") or "none" for a in albums)
    print(
        f"artwork: coverartarchive={art.get('coverartarchive', 0)} "
        f"deezer={art.get('deezer', 0)} missing={art.get('none', 0)} "
        f"of {len(albums)} albums; album cache: {cache.stats()}",
        file=sys.stderr,
    )
    print(
        f"merged {merge_count} duplicate scrobble group(s) into existing releases; "
        f"{len(newly_unlocked)} album(s) unlocked as a result",
        file=sys.stderr,
    )
    for a in newly_unlocked:
        print(f"  * {a['artist']} - {a['title']}", file=sys.stderr)
    cache.close()
    print(f"wrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
