# Crates — build spec

## Product
Open the app, see a shelf of milk crates holding vinyl records. An album only
appears in a crate once every track on it has been played. Crates are grouped by
genre. Secondary screens: full listening stats, and "almost unlocked" albums.

Long-horizon target: a real iOS app distributed via TestFlight, then the App Store.

## Hard constraints discovered in the data
- Source is `data/scrobbles.csv` — a Last.fm scrobble export, 136,512 rows,
  Apr 2020 – Aug 2026. Columns: uts, utc_time, artist, artist_mbid, album,
  album_mbid, track, track_mbid.
- There is NO Spotify integration. Nothing is live.
- 7,283 distinct (artist, album) pairs; only 882 have >=5 distinct tracks played.
- mbid fill rates: artist 71.9%, album 66.6%, track 64.4%.
- The CSV contains NO tracklists and NO genres. Both must be enriched externally.
- Album names are messy: deluxe/remaster suffixes, and the same album appears
  under variant artist names (e.g. "Nat King Cole" vs "The Nat King Cole Trio").
  Track names carry suffixes like " - Remastered".

## The contract: data/collection.json
Both workstreams build against this file. The pipeline writes it; the app reads it.

```json
{
  "generated_at": "2026-09-17T00:00:00Z",
  "stats": {
    "total_plays": 136512,
    "distinct_artists": 3430,
    "first_play": "2020-04-01T00:00:00Z",
    "last_play": "2026-08-14T20:15:00Z",
    "unlocked_count": 0,
    "in_progress_count": 0
  },
  "genres": [
    { "id": "hip-hop", "label": "Hip-Hop", "album_count": 0 }
  ],
  "albums": [
    {
      "id": "mbid-or-slug",
      "artist": "J Dilla",
      "title": "Donuts",
      "release_year": 2006,
      "genre_id": "hip-hop",
      "cover_url": null,
      "total_tracks": 31,
      "played_tracks": 31,
      "completion": 1.0,
      "unlocked": true,
      "unlocked_at": "2021-06-02T18:44:00Z",
      "play_count": 412,
      "missing_tracks": [],
      "source": "musicbrainz"
    }
  ],
  "unresolved": [
    { "artist": "...", "album": "...", "reason": "no_mb_match", "play_count": 3 }
  ]
}
```

Rules:
- `unlocked` is true only when every track on the canonical tracklist has at
  least one play. No partial credit.
- `unlocked_at` is the timestamp of the play that completed the album.
- Albums that could not be resolved to a tracklist are EXCLUDED from `albums`
  and listed in `unresolved` with a reason. Never infer a tracklist from the
  plays themselves — that would make every album trivially 100%.
- `genre_id` is a small controlled vocabulary (aim for 8-15 crates), not raw
  Last.fm/MusicBrainz tags. Map many tags onto few crates.

## Workstreams
1. `pipeline/` — enrichment. Owns collection.json. Critical path.
2. `app/` — Expo/React Native client. Reads collection.json. Ships to TestFlight.

## Distribution reality
iOS via TestFlight requires an Apple Developer Program membership ($99/yr) under
the user's own Apple ID. Claude cannot enroll, create certificates, or submit
builds. Those steps are the user's.

## Pipeline
`pipeline/` owns `data/collection.json`. Run it with the repo venv:

```bash
venv/Scripts/python.exe -m pipeline.build --min-tracks 5   # the unlock candidates
venv/Scripts/python.exe -m pipeline.build                  # all ~7,100 album groups
venv/Scripts/python.exe -m pipeline.build --offline        # re-bucket genres from cache only
venv/Scripts/python.exe -m pytest pipeline/tests -q        # unit tests
```

Tracklists and genres come from MusicBrainz (1 req/s, descriptive User-Agent).
Every response is cached in `pipeline/.cache/` (gitignored), so reruns are
instant and an interrupted run resumes. `collection.json` is rewritten
atomically every 25 groups and carries `stats.partial: true` until the run
completes, so the app can read it while it is still filling.

Crates are defined in `pipeline/genre_map.yaml` — a readable tag -> crate table
that is a product decision, not an implementation detail.

Albums also carry two diagnostic fields outside the contract that the app may
ignore: `_fuzzy_matches` and `_genre_tags`.

Full details, flags and known match-quality caveats: `pipeline/README.md`.
