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
| `scrobbles.py` | Streams the CSV and folds rows into `AlbumGroup`s keyed on normalized (artist, album). Tracks first-play timestamps per distinct track. `merge_group` unions two groups that turn out to be the same release. |
| `musicbrainz.py` | Rate-limited (1 req/s), disk-cached, retrying MB web-service client with the required descriptive User-Agent. |
| `resolve.py` | Group → MusicBrainz release. Prefers the scrobbled `album_mbid`; otherwise scores search candidates on artist/title/track-count. |
| `completion.py` | One-to-one matching of played tracks against the canonical tracklist; completion, `unlocked`, `unlocked_at`, `missing_tracks`. |
| `genres.py` + `genre_map.yaml` | Maps raw MB tags onto the 14-crate controlled vocabulary. **`genre_map.yaml` is the product knob** — edit it freely. |
| `artwork.py` | Cover resolution: Cover Art Archive by MBID, Deezer as fallback. Rate-limited, cached, strict matching via `normalize.py`. |
| `colors.py` | Dominant-colour extraction (Pillow) → `colors: {primary, secondary}` for the gradient progress bar. |
| `album_cache.py` | The structured album store: SQLite, keyed by release MBID, TTL-refreshed. |
| `httpcache.py` | The raw response layer underneath it — sharded JSON + blob caches in `.cache/`. |
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
* `--artwork-only` — replay MusicBrainz from cache and spend the network on
  artwork alone. This is the fast path for an artwork/colour backfill over an
  already-resolved collection.
* `--no-artwork` / `--no-deezer` / `--no-colors` — turn off artwork resolution,
  the Deezer fallback, or colour extraction.
* `--recolor` — re-derive the colours from already-cached sleeves. Costs no
  network; use it after changing anything in `colors.py`.
* `--album-db` / `--cache-ttl-days` — the structured album cache and its TTL
  (default 30 days; `0` disables the TTL).
* `--artwork-workers N` — threads used to pre-warm cover downloads (default 8,
  `1` disables). A Cover Art Archive fetch redirects to archive.org and takes
  1.5-3s, almost all of it waiting, so overlapping the transfers is the
  difference between ~30 minutes and a few hours. Request *starts* are still
  rate-limited; only the waiting overlaps.
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

### Two cache layers

`pipeline/.cache/` now holds both:

1. **Raw responses** (`httpcache.py`) — sharded JSON for MusicBrainz and Deezer
   lookups, plus a blob cache of downloaded cover images so colour extraction
   never re-downloads a sleeve. Negative answers are cached as answers: a CAA
   404 is asked exactly once, ever.
2. **The album store** (`album_cache.py`) — `.cache/albums.sqlite3`, keyed by
   release MBID:

   ```
   albums(mbid PK, artist, title, release_year,
          tracklist JSON, genre_tags JSON, genre_id,
          artwork_url, artwork_source, color_primary, color_secondary,
          color_strategy, fetched_at, schema_version)
   ```

   Per [`docs/CATALOG.md`](../docs/CATALOG.md) this is **not** a mirror of
   MusicBrainz — it is a lazily populated cache of albums somebody has actually
   played, so a thousand users who all play *Donuts* cost one upstream lookup.
   Rows carry `fetched_at` and are re-resolved once they are older than
   `--cache-ttl-days` (default 30). SQLite because it is stdlib, serverless and
   a single file, and unlike the JSON shards it can answer "how many cached
   albums still have no artwork". Never store Spotify-derived fields in it.

## Artwork

`cover_url` comes from **Cover Art Archive** first (by release MBID — no
matching required, the MBID *is* the key) and **Deezer**'s keyless public API
as a fallback. CAA holds front covers for ~66% of MusicBrainz releases, so a
404 is an ordinary answer, not an error. MusicBrainz's own
`cover-art-archive.front` flag rides along with the release fetch, so most
absences cost zero requests.

Deezer needs real matching, and it uses `normalize.py` — the same normalizer as
the tracklist resolver, not a second one. Matching is deliberately strict
(artist must match exactly or ≥0.86 by ratio; title exactly or ≥0.90): a
plausible-but-wrong sleeve is worse than a blank one, because it also puts the
wrong gradient on the album. Deezer's limit of 50 requests / 5 seconds is
enforced with a sliding window; CAA is kept to a polite ~3 req/s.

**Spotify is never used for artwork.** Their Developer Terms forbid persistent
storage of cover art and forbid deriving from it (which a dominant-colour
gradient plainly does). See `docs/CATALOG.md`. Do not add a Spotify path here.

## Dominant colours

Each album gets `colors: {primary, secondary}` for the app's animated gradient
progress bar. The sleeve is thumbnailed to 120px, median-cut quantized to 16
colours, and near-identical palette entries merged (ΔE < 6) so JPEG noise does
not read as sixteen distinct colours.

Three guarantees the gradient depends on:

* **Never null.** Both keys are always present, always `#rrggbb`.
* **Never collapsed.** The secondary is the heaviest cluster at least
  **ΔE ≥ 18** (CIE76, in Lab — RGB distance misjudges how different colours
  *look*) from the primary, measured on the colours that actually ship, *after*
  contrast correction. Checking before it is how a gradient goes flat without
  anyone noticing: two different near-blacks are far apart raw and identical
  once both have been lifted. A single-colour or near-white sleeve — the White
  Album, Donda's black square — has no qualifying cluster at all, so the
  secondary is *derived*: same hue nudged ~12°, lightness stepped away from
  whichever end the primary sits nearest, widening until the pair clears ΔE 18
  with the partner also on the contrast floor.
* **Never invisible.** Both colours are lifted until each clears **3:1 contrast
  against `#121212`** — WCAG 2.1 SC 1.4.11, the minimum for a non-text UI
  component, which is exactly what a progress bar is. Lifting happens in HLS so
  a deep navy stays navy instead of turning grey. This is also why "is this a
  colour?" is judged on the lifted colour — see below.

### Picking the pair

"The two most dominant colours" is the wrong rule taken literally. Sleeves are
scanned with a white border and plenty of covers are a photograph floating in
white space, so plain white or grey routinely wins on pixel count for a record
that is not remotely white. *Rodeo* is a warm photo in a white frame; *CALL ME
IF YOU GET LOST* is a green-and-gold photo. And demoting white out of the
*primary* slot alone is not enough — it just lands in the other slot, and
gold-to-white renders as a beige smear exactly like white-to-gold.

So **both** ends are chosen from the sleeve's real colours before greyscale is
considered at all, in this order:

1. A colour covering **≥ 4%** of the sleeve leads. Its partner is the most
   colourful other qualifying colour (**≥ 1.5%**) — `saturated` — or, if there
   is only one colour on the sleeve, a tint of it — `saturated-derived`.
2. Otherwise, if the sleeve's only colour is too small to lead, the greyscale
   dominant keeps the primary slot and that colour partners it —
   `saturated-partner`.
3. Otherwise, if the dominant has any tint at all, that tint is carried through
   both ends rather than paired with neutral grey — `derived`.
4. Otherwise the sleeve is genuinely greyscale and is reported as such —
   `dominant`. 86 of the 808 albums are: the White Album, *Madvillainy*,
   *Circles*, *Yeezus*. Grey is the honest answer for those.

The primary is ordered by **presence** and the partner by **colourfulness**,
because they do different jobs: the primary is what the album looks like, the
partner is what makes the gradient read.

### What counts as a colour

Not HLS saturation, which is unusable here. `#060a0b` is black with five levels
of rounding noise on it and HLS calls it 0.29 saturated — more than an olive
green. A cluster is a colour only if all three hold:

* its lightness is inside `[0.06, 0.95]` — hue is not trustworthy at the ends;
* it has **some** Lab chroma before lifting (≥ 5) — a real dark colour does,
  black-plus-noise does not;
* it has **enough** Lab chroma *after* being lifted onto the contrast floor
  (≥ 13) — that is the colour the app actually renders, and Lab chroma is
  compressed at low lightness, so judging the raw cluster discards real colours.

The middle gate is the one that matters most in practice. Without it, lifting
a near-black cluster manufactures a confident hue that is nowhere on the
sleeve: *All Eyez on Me* led with a teal, *Aquemini* with a green and *Come to
My Garden* with a magenta, all invented out of pixels that were essentially
black. Those look like good colours in a JSON diff and are simply wrong.

`--recolor` re-derives every album's colours from the cached sleeves without
touching the network, which is what makes these rules cheap to tune.

## Matching rules, and where they can be wrong

* Dedup happens **twice**: before resolution on the normalized (artist, album)
  key, and again after it on the release MBID. The normalizer cannot fold
  every case — "Cordae" / "YBN Cordae", a soundtrack credited to a different
  collaborator, `(Extended Version)` — and those splits only become visible
  once both groups land on the same release. Merged groups have their play sets
  unioned and `completion` / `unlocked` / `unlocked_at` recomputed from the
  union; without it the plays split in half and real unlocks are suppressed.
  The merged record takes its name from the release's own artist credit and
  title, and `build.py` refuses to write a `collection.json` with a duplicate
  `albums[].id`.
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

Covers the normalizer (suffix stripping, identity preservation, artist folding),
the completion logic (unlock rules, `unlocked_at`, one-to-one matching,
multi-disc tracklist flattening), the Deezer matcher and rate limiter, the
album cache (round-trip, upsert, TTL expiry, coverage stats), the colour rules
(contrast floor, degenerate single-colour sleeves, never-null), and the
post-resolution merge (play-set union, recomputed `unlocked_at`, `id`
uniqueness) against small inline fixtures and generated images. No network.
