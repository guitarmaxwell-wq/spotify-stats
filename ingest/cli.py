"""Command line for the ingest package.

    venv/Scripts/python.exe -m ingest.cli status
    venv/Scripts/python.exe -m ingest.cli csv --path data/scrobbles.csv
    venv/Scripts/python.exe -m ingest.cli lastfm --user max --full
    venv/Scripts/python.exe -m ingest.cli spotify-export --path ~/Downloads/my_spotify_data.zip
    venv/Scripts/python.exe -m ingest.cli spotify-poll --token <access token>
    venv/Scripts/python.exe -m ingest.cli export-csv --out data/plays.csv
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone

from . import config
from .groups import export_csv, load_groups_from_store
from .schema import DEFAULT_MIN_MS_PLAYED, Source
from .sources.base import SourceError
from .sources.lastfm_api import LastfmSource
from .sources.lastfm_csv import LastfmCsvSource
from .sources.spotify_export import SpotifyExportSource
from .sources.spotify_recent import SpotifyRecentSource
from .store import DEFAULT_PLAYS, DEFAULT_STATE, PlayStore


def _store(args) -> PlayStore:
    return PlayStore(args.plays, args.state).load()


def _report(result) -> int:
    print(result.summary())
    for w in result.warnings:
        print(f"  ! {w}", file=sys.stderr)
    if result.cursor.get("suspected_gaps"):
        print(f"  ! {result.cursor['suspected_gaps']} suspected gap(s) on this source",
              file=sys.stderr)
    return 0


def _ts(v: int) -> str:
    if not v:
        return "never"
    return datetime.fromtimestamp(v, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def cmd_status(args) -> int:
    store = _store(args)
    s = store.stats()
    print(f"{s['total_plays']:,} plays in {store.plays_path}")
    if s["corrupt_lines"]:
        print(f"  ({s['corrupt_lines']} unreadable line(s) skipped)")
    if s["total_plays"]:
        print(f"  range   {_ts(s['first_ts'])} -> {_ts(s['last_ts'])}")
    for name in Source.ALL:
        n = s["by_source"].get(name, 0)
        cur = store.cursors.get(name)
        line = f"  {name:<16} {n:>8,} plays"
        if cur:
            line += f"  cursor {_ts(cur.last_ts)}  synced {_ts(cur.last_synced_at)}"
            if cur.suspected_gaps:
                line += f"  gaps {cur.suspected_gaps}"
        print(line)
    return 0


def cmd_csv(args) -> int:
    return _report(LastfmCsvSource(args.path).sync(_store(args)))


def cmd_lastfm(args) -> int:
    user = args.user or config.lastfm_username()
    key = args.api_key or config.lastfm_api_key()
    if not user:
        raise SourceError("pass --user or set LASTFM_USERNAME (see .env.example)")
    if not key:
        raise SourceError("pass --api-key or set LASTFM_API_KEY (see .env.example)")

    def progress(page, total):
        print(f"  page {page}/{total}", end="\r", file=sys.stderr, flush=True)

    src = LastfmSource(user, key, on_progress=progress)
    result = src.sync(_store(args), full=args.full, max_pages=args.max_pages)
    print(file=sys.stderr)
    return _report(result)


def cmd_spotify_export(args) -> int:
    return _report(SpotifyExportSource(args.path, min_ms=args.min_ms).sync(_store(args)))


def cmd_spotify_poll(args) -> int:
    if not config.spotify_client_id() and not args.token:
        raise SourceError(
            "no Spotify access token. The token comes from the app's PKCE login; "
            "there is no way to obtain one from this CLI without a client id you "
            "created yourself at developer.spotify.com (see ingest/README.md)."
        )
    src = SpotifyRecentSource(args.token)
    store = _store(args)
    if args.watch:
        for result in src.sync_forever(store, interval_s=args.interval):
            _report(result)
        return 0
    return _report(src.sync(store))


def cmd_export_csv(args) -> int:
    store = _store(args)
    n = export_csv(store.events, args.out, min_ms=args.min_ms)
    print(f"wrote {n:,} rows to {args.out}")
    print(f"  now run: python -m pipeline.build --csv {args.out}")
    return 0


def cmd_groups(args) -> int:
    store = _store(args)
    groups, stats = load_groups_from_store(store, min_ms=args.min_ms)
    print(f"{stats['group_count']:,} album groups from {stats['total_plays']:,} counted plays")
    print(f"  {stats['rows_without_album']:,} plays had no album")
    print(f"  {stats['skipped_below_threshold']:,} plays below the {args.min_ms}ms threshold")
    for g in groups[: args.limit]:
        print(f"  {g.distinct_tracks:>3} tracks  {g.artist} - {g.album}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m ingest.cli", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--plays", default=str(DEFAULT_PLAYS))
    p.add_argument("--state", default=str(DEFAULT_STATE))
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("status", help="what is in the store and where each cursor sits")
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("csv", help="import a Last.fm CSV export")
    sp.add_argument("--path", default="data/scrobbles.csv")
    sp.set_defaults(func=cmd_csv)

    sp = sub.add_parser("lastfm", help="sync from the Last.fm API")
    sp.add_argument("--user")
    sp.add_argument("--api-key")
    sp.add_argument("--full", action="store_true", help="re-walk all history")
    sp.add_argument("--max-pages", type=int, default=5000)
    sp.set_defaults(func=cmd_lastfm)

    sp = sub.add_parser("spotify-export", help="import an Extended Streaming History zip")
    sp.add_argument("--path", required=True, help="zip, directory or single JSON file")
    sp.add_argument("--min-ms", type=int, default=0,
                    help="drop plays shorter than this at import (default: keep all)")
    sp.set_defaults(func=cmd_spotify_export)

    sp = sub.add_parser("spotify-poll", help="poll recently-played once, or watch")
    sp.add_argument("--token", help="a valid access token from the app's PKCE login")
    sp.add_argument("--watch", action="store_true")
    sp.add_argument("--interval", type=int, default=1800)
    sp.set_defaults(func=cmd_spotify_poll)

    sp = sub.add_parser("export-csv", help="write the store as a Last.fm-shaped CSV")
    sp.add_argument("--out", default="data/plays.csv")
    sp.add_argument("--min-ms", type=int, default=DEFAULT_MIN_MS_PLAYED)
    sp.set_defaults(func=cmd_export_csv)

    sp = sub.add_parser("groups", help="preview album groups built from the store")
    sp.add_argument("--min-ms", type=int, default=DEFAULT_MIN_MS_PLAYED)
    sp.add_argument("--limit", type=int, default=20)
    sp.set_defaults(func=cmd_groups)

    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except SourceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\ninterrupted — plays already fetched are saved", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
