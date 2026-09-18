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
      "cover_url": "https://coverartarchive.org/release/<mbid>/front-500",
      "artwork_source": "coverartarchive",
      "colors": { "primary": "#d59602", "secondary": "#f12b1d" },
      "color_strategy": "saturated",
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
- **`albums[].id` is unique.** It is the record's identity and the app's list
  key. Grouping scrobbles on a normalized (artist, album) key cannot catch
  every variant — "Cordae" / "YBN Cordae", a soundtrack credited to a different
  collaborator, "(Extended Version)" — so dedup also happens *after* release
  resolution: two groups that resolve to the same MusicBrainz release are the
  same record, and their play sets are unioned, play counts summed, and
  `completion` / `unlocked` / `unlocked_at` recomputed from the union. Without
  that the plays split across two records and real unlocks are suppressed. The
  build fails rather than emitting a duplicate id. A merged record is named
  after the MusicBrainz release's own artist credit and title, and carries
  `_merged_from` (how many scrobble groups it absorbed);
  `stats.merged_groups` counts the merges.
- `unlocked` is true only when every track on the canonical tracklist has at
  least one play. No partial credit.
- `unlocked_at` is the timestamp of the play that completed the album.
- Albums that could not be resolved to a tracklist are EXCLUDED from `albums`
  and listed in `unresolved` with a reason. Never infer a tracklist from the
  plays themselves — that would make every album trivially 100%.
- `genre_id` is a small controlled vocabulary (aim for 8-15 crates), not raw
  Last.fm/MusicBrainz tags. Map many tags onto few crates.
- `cover_url` is Cover Art Archive or Deezer, **never Spotify** — a licensing
  constraint, see `docs/CATALOG.md`. It is `null` when neither source has the
  sleeve. `artwork_source` is `"coverartarchive"`, `"deezer"` or `"none"`.
- `colors` are the two dominant colours of the sleeve, for the animated
  gradient progress bar. Contract the app can rely on:
  - **`colors` is never null, and neither `primary` nor `secondary` is ever
    null.** Always present, always `#rrggbb` lowercase — an album with no
    artwork anywhere gets a neutral fallback pair rather than nothing, so the
    progress bar never has to branch.
  - The two are always *visibly* different (CIE76 ΔE ≥ 18), even for a
    single-colour or near-white sleeve, so the gradient never collapses into a
    flat bar. For a monochrome sleeve the secondary is a tinted/shaded variant
    of the primary.
  - Both clear **3:1 contrast against `#121212`** — the WCAG 2.1 SC 1.4.11
    minimum for a non-text UI component — so the bar reads on a dark UI. Dark
    sleeves are lightened in HLS, preserving hue and saturation.
  - The pair is not literally "the two most common colours". Sleeves are
    scanned with a white border and many covers are a photo floating in white
    space, so plain white or grey routinely wins on pixel count for a record
    that is not remotely white. **Both ends are drawn from the sleeve's real
    colours before greyscale is considered at all** — taking only the primary
    from them just moves the white into the other slot, and gold-to-white is a
    beige smear exactly like white-to-gold. A sleeve that really is monochrome
    (the White Album, *Madvillainy*) gets a greyscale pair, which is honest.
  - Every album carries **`color_strategy`**, so the rules stay auditable
    against the artwork later:

    | value | meaning |
    |---|---|
    | `saturated` | both ends are real colours off the sleeve |
    | `saturated-derived` | one real colour leads; the partner is a tint of it, not the white it sat on |
    | `saturated-partner` | greyscale sleeve whose only colour is too small (<4%) to lead |
    | `derived` | muted sleeve; the dominant's own tint is carried through both ends |
    | `dominant` | genuinely greyscale sleeve: the two most common colours |
    | `neutral-fallback` | no artwork at all; a neutral pair so the bar still renders |

  `stats.artwork` reports coverage: `with_cover`, `coverartarchive`, `deezer`,
  `missing`, `with_colors`.

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
venv/Scripts/python.exe -m pipeline.build --artwork-only   # artwork/colour backfill (MB from cache)
venv/Scripts/python.exe -m pytest pipeline/tests -q        # unit tests
```

Tracklists and genres come from MusicBrainz (1 req/s, descriptive User-Agent);
artwork from the Cover Art Archive with Deezer as a fallback. Every response is
cached in `pipeline/.cache/` (gitignored) — raw HTTP shards plus
`albums.sqlite3`, the structured per-MBID album cache described in
`docs/CATALOG.md` — so reruns are instant and an interrupted run resumes.
`collection.json` is rewritten atomically every 25 groups and carries
`stats.partial: true` until the run completes, so the app can read it while it
is still filling.

Crates are defined in `pipeline/genre_map.yaml` — a readable tag -> crate table
that is a product decision, not an implementation detail.

Albums also carry diagnostic fields outside the contract that the app may
ignore: `_fuzzy_matches`, `_genre_tags` and `_merged_from`.

Full details, flags and known match-quality caveats: `pipeline/README.md`.
