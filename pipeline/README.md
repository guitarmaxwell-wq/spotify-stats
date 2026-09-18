# pipeline/ — scrobbles.csv → collection.json

Turns the Last.fm export in `data/scrobbles.csv` into `data/collection.json`,
the contract defined in [`docs/SPEC.md`](../docs/SPEC.md).

The CSV records what was **played**. It does not record what **exists**. An
album can only be "unlocked" if we know its canonical tracklist, so every album
group is resolved against MusicBrainz. Albums with no resolvable tracklist land
in `unresolved` and are never given an inferred tracklist — inferring one from
the plays would make every album trivially 100% complete.

## Modules

| file | role |
| --- | --- |
| `normalize.py` | Title/artist normalization. Strips `- Remastered`, `(Deluxe Edition)`, `(feat. X)` etc.; folds artist variants (`The Nat King Cole Trio` → `nat king cole`). Pure, no I/O, heavily tested. |
| `scrobbles.py` | Streams the CSV and folds rows into `AlbumGroup`s keyed on normalized (artist, album). Tracks first-play timestamps per distinct track. |
| `musicbrainz.py` | Rate-limited (1 req/s), disk-cached, retrying MB web-service client with the required descriptive User-Agent. |
| `resolve.py` | Group → MusicBrainz release. Prefers the scrobbled `album_mbid`; otherwise scores search candidates on artist/title/track-count. |
| `completion.py` | One-to-one matching of played tracks against the canonical tracklist; completion, `unlocked`, `unlocked_at`, `missing_tracks`. |
| `genres.py` + `genre_map.yaml` | Maps raw MB tags onto the 14-crate controlled vocabulary. **`genre_map.yaml` is the product knob** — edit it freely. |
| `build.py` | `python -m pipeline.build` entry point; orchestration, checkpointing, output. |

## Running it

```bash
# fast iteration — first 20 album groups
venv/Scripts/python.exe -m pipeline.build --limit 20

# the unlock candidates (882 groups with >=5 distinct tracks played)
venv/Scripts/python.exe -m pipeline.build --min-tracks 5

# everything (~7,100 groups; hours on a cold cache, minutes on a warm one)
venv/Scripts/python.exe -m pipeline.build
```

Useful flags:

* `--limit N` — only the first N groups (groups are ordered most-distinct-tracks
  first, so this always gives you the best unlock candidates).
* `--min-tracks N` — skip groups with fewer than N distinct played tracks.
* `--offline` — never touch the network; answer only from the HTTP cache. Use
  this to re-bucket genres after editing `genre_map.yaml` (seconds, not hours).
* `--no-genre-lookups` — use the tags that ship with the release fetch only.
* `--csv` / `--out` / `--checkpoint-every`.

## Rate limits, caching and resumability

MusicBrainz permits **one request per second** and requires a descriptive
User-Agent with contact info. Both are enforced inside `MusicBrainzClient`
(`USER_AGENT = "CratesApp/0.1 ( https://github.com/guitarmaxwell-wq/spotify-stats )"`).

Every response — including 404s — is cached under `pipeline/.cache/`
(gitignored, sharded by hash). Consequences:

* A rerun is effectively free; only genuinely new lookups hit the network.
* The run is resumable: kill it and restart with the same arguments.
* `collection.json` is rewritten every `--checkpoint-every` groups (atomically,
  via a temp file + rename), and carries `stats.partial: true` until the run
  finishes, so the app can read it mid-run.

To refresh against upstream MusicBrainz changes, delete `pipeline/.cache/` (or
just the shards you care about) and re-run.

## Matching rules, and where they can be wrong

* Matching is **one-to-one**: one played track satisfies at most one canonical
  slot. Without that, a fuzzy match could fill two slots and manufacture a
  false unlock.
* Match tiers, best first: exact normalized key → whitespace-squashed → variant
  suffix (`Jay Dee 1` ≈ `Jay Dee 1 - Instrumental`) → prefix → difflib ≥ 0.90.
* `unlocked` requires **every** canonical track to have ≥1 play. No partial
  credit.
* `unlocked_at` is the latest of the per-track first plays — i.e. the play that
  completed the album.
* Each album carries diagnostic fields outside the contract that the app can
  ignore: `_fuzzy_matches` (how many slots needed a non-exact match — a high
  count on an "unlocked" album deserves suspicion) and `_genre_tags` (the raw
  MB tags that produced `genre_id`).

Known failure modes:

* **Box sets.** A scrobbled `album_mbid` pointing at a 349-track anthology
  produces a huge `total_tracks` that will never unlock. Real, not a bug —
  the play data really is against that release.
* **Wrong pressing.** Search resolution can pick a different edition with bonus
  tracks, so an album you did finish shows 14/17.
* **Ambient / sleep / library music** (`The Wild Earth` etc.) is frequently
  absent from MusicBrainz entirely → `unresolved: no_mb_match`.

## Tests

```bash
venv/Scripts/python.exe -m pytest pipeline/tests -q
```

Covers the normalizer (suffix stripping, identity preservation, artist folding)
and the completion logic (unlock rules, `unlocked_at`, one-to-one matching,
multi-disc tracklist flattening) against small inline fixtures. No network.
