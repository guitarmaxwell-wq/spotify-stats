# ingest — getting a user's listening history in

Three paths. They are **not** alternatives to each other; each one solves a part
of the problem that the others cannot, and the UI is built to say so.

| Path | Backfills the past? | Keeps up going forward? | Can it ship publicly? |
|---|---|---|---|
| **Last.fm** (`lastfm`) | Yes — all of it | Yes | **Yes** |
| **Spotify sign-in** (`spotify_recent`) | **No. Not at all.** | Yes | **No** — 25 users, hard cap |
| **Spotify export** (`spotify_export`) | Yes — all of it | No | Yes, but it is a manual download |

If you read nothing else: **Spotify cannot backfill a shelf.** That is not a
missing feature or a wrong endpoint, it is the shape of their API. The prior
research in `docs/DATA_SOURCES.md` establishes this and this package is designed
around it rather than rediscovering it.

---

## The common play-event schema

Everything normalizes into one record (`ingest/schema.py`, mirrored in
`app/src/link/types.ts`). `data/scrobbles.csv` stops being "the input" and
becomes one source among four.

```jsonc
{
  "ts": 1600000000,              // Unix SECONDS, UTC. Required.
  "artist": "Nat King Cole",     // Required. Cleaned, not raw.
  "track": "Route 66",           // Required. Cleaned: " - Remastered" stripped.
  "source": "spotify_export",    // lastfm | lastfm_csv | spotify_recent | spotify_export
  "album": "After Midnight",     // Optional — one source never has it.
  "ms_played": 175000,           // ONLY ever on spotify_export.
  "duration_ms": 180000,         // spotify_recent knows this; the export does not.
  "artist_mbid": null,           // Last.fm only, ~72% fill rate.
  "album_mbid": null,
  "track_mbid": null,
  "foreign_id": "spotify:track:…" // Spotify URI when known.
}
```

Absent fields are omitted rather than written as `null`, so a Last.fm event does
not carry six null columns.

### Timestamps mean different things and we record which

Last.fm's `uts` is when the track **started**. Spotify's `played_at` and the
export's `ts` are when it **stopped**. That is a whole track-length of skew
between two records of the same listen, which matters enormously for a user who
has both linked. We do not try to correct it — that would mean guessing a
duration we usually do not have — we record `ts_kind` per source and widen the
de-duplication window instead.

### De-duplication

- **Within a source**, only an exact `(artist, track, ts)` repeat is a duplicate.
  A source never emits the same play twice at different times, and collapsing
  near-identical timestamps would silently eat a track played twice on repeat.
- **Across sources**, the same artist+track within a tolerance window is one
  play. The window is 4 minutes, widening to the track's duration + 60s when
  we know it.

So a user with Spotify *and* Last.fm linked gets one shelf, not double counts.

### Punctuation-only names

`pipeline/normalize.py` strips punctuation to build match keys, so a name made
entirely of it collapses to `""`. This is not hypothetical — `¥$` (Kanye West &
Ty Dolla $ign) and tracks titled `?` are in the real data. Dropping them loses
every play of *Vultures 1*; folding them all onto one empty key merges unrelated
artists. `safe_key` falls back to a lightly-folded raw string, which keeps them
distinct. Verified against the real 136,512-row CSV: same 7,132 album groups as
the pipeline, zero track-count differences, and seven groups that previously
shared an empty key now correctly separated.

---

## `ms_played`: what counts as a listen

Only the Spotify export reports how long a track actually played. The decision,
implemented in `PlayEvent.counts_as_listen`:

> **A play counts toward unlocking when `ms_played >= 30_000`.
> If the track is shorter than 30s, it counts at half its length.
> Sources with no `ms_played` always count.**

Why 30 seconds rather than the 10 the brief floated:

- **10s is too generous for an "every track played" mechanic.** Ten seconds is
  an intro. Letting it unlock a record devalues the entire premise of the app —
  the shelf is supposed to mean you actually listened to the thing.
- **30s is the threshold the industry already uses** for what counts as a
  stream, so it matches what a user intuits a "play" to be.
- **It stays close to Last.fm's behaviour**, which is the baseline for most of
  this data. Last.fm scrobbles at 50% of a track or 4 minutes, whichever is
  first. 30s is *more* generous than that, so folding Spotify-export plays in
  next to Last.fm scrobbles does not make the export path artificially stricter
  and produce a shelf that depends on which source a play came from.
- **The short-track rule is not a detail.** *Donuts* has a dozen tracks under 30
  seconds; a flat floor would make it permanently un-unlockable. Any album full
  of interludes or skits has the same problem.

A play marked `"skipped": true` still counts if it passed the threshold —
skipping the outro of a four-minute track is a listen, not a skip.

Two deliberate consequences:

1. **The raw `ms_played` is stored, never discarded.** The threshold is applied
   when album groups are built (`ingest/groups.py`), not at import. The rule can
   change and the whole collection rebuilds without asking anyone to re-import a
   zip they waited a month for.
2. **Last.fm plays are not second-guessed.** They have no duration, and
   inventing one would just be making up a rule. Last.fm already applied its own
   threshold upstream.

---

## 1. Last.fm — the path that actually ships

```bash
venv/Scripts/python.exe -m ingest.cli lastfm --user <name> --full   # backfill
venv/Scripts/python.exe -m ingest.cli lastfm --user <name>          # incremental
```

Needs an API key (`LASTFM_API_KEY`, one minute to create, no review) and a
public username. No OAuth, no user token, no allowlist, no approval. That is the
whole argument for it.

**Real limits:**

- ~1 request/second, 200 scrobbles per page. Backfilling 136k scrobbles is ~680
  requests, about 12 minutes. Incremental syncs are one or two requests.
- **The user must already scrobble.** Someone who has never used Last.fm has
  nothing to import. They can connect Spotify to Last.fm in a few minutes, but
  their shelf then starts from today.
- Commercial use needs a separate agreement (`partners@last.fm`). Free and
  unmonetized is defensible; the moment there is IAP, get it in writing.
- Attribution required; 100MB stored-data cap in the ToS.
- Data quality is the known weakness — messy album names, no tracklists, no
  genres. That is exactly what `pipeline/` exists to fix.

**Two paging traps, both handled:**

- **The window is pinned.** Every page passes the same `to=`, fixed at the start
  of the sync. Without it, scrobbles arriving mid-backfill shift page boundaries
  and tracks vanish between pages.
- **Pages arrive newest-first**, so the cursor is only trustworthy once the last
  page lands. Advancing per page would mark the user caught-up while their older
  history was still unfetched — and an interrupt there loses it permanently.
  Events are written per page; the cursor moves once, at the end.

Incremental syncs re-read a **14-day lookback window** rather than resuming
exactly at the mark, because offline scrobblers upload batches carrying *old*
timestamps that would otherwise land behind the cursor and be lost. Dedupe makes
the overlap free.

## 2. Spotify sign-in — forward sync, and only forward

```bash
venv/Scripts/python.exe -m ingest.cli spotify-poll --token <access token>
venv/Scripts/python.exe -m ingest.cli spotify-poll --token <…> --watch
```

OAuth 2.0 **PKCE**, no client secret — this is a mobile app and there is nowhere
safe to put one. The app implements the flow (`app/src/link/spotify.ts`) with
`expo-auth-session`; tokens go to `expo-secure-store`, never AsyncStorage.

Each poll asks `recently-played` for everything after the high-water mark, so
repeated polls are cheap and idempotent.

**Real limits:**

- **No history. At all.** ~50 plays retained; the cursors move only inside that
  buffer. A user who links today has an empty shelf today.
- **The gap.** Play 60 tracks between two polls and the oldest 10 are gone
  before we ever see them, unrecoverably. We detect it — a poll returning a full
  page almost certainly means loss — count it on the cursor, and surface it,
  rather than under-counting an album forever with no explanation.
- **Something must be running.** "Keeps filling as they listen" means polling
  every ~30 minutes. On device that is a foreground refresh; as a service it is
  a server you host.
- **25 users, hard cap.** See below.

## 3. Spotify Extended Streaming History — the only real Spotify backfill

```bash
venv/Scripts/python.exe -m ingest.cli spotify-export --path ~/Downloads/my_spotify_data.zip
```

Accepts the zip as downloaded, an unzipped directory, or a single JSON file.

**Real limits:**

- Manual. spotify.com → Account → Privacy → **"Extended streaming history"**.
  Officially up to 30 days; usually 1–5. There is no API for it and there cannot
  be one.
- Users constantly request the wrong thing. **"Account data"** is a different
  request that only covers 12 months and has no album field. Both formats are
  read, and the account-data one is called out explicitly, because someone who
  waited three weeks for the wrong zip should be told.
- Podcast and audiobook rows are skipped, not counted as errors.

It is a genuinely excellent one-off import and a terrible onboarding flow.
Support it; never depend on it.

---

## Storage

`data/plays.jsonl` (one event per line) and `data/ingest_state.json` (cursors).
Both gitignored — the first is personal data, and both are regenerable.

Append-only on disk, de-duplicating in memory. An interrupted sync loses at most
the events it had not flushed, never the history. A truncated last line after a
hard kill is skipped and counted, not fatal.

Commit order is **events → cursor → state**, deliberately. Crash between the
append and the cursor write and we re-fetch a few plays and de-duplicate them;
do it the other way round and we lose them.

Cursors are **monotonic**. Importing a 2020 export must not rewind the
forward-sync cursor and make tomorrow's poll re-walk from 2020.

## Feeding the pipeline

`pipeline/scrobbles.py` is untouched and still reads the CSV. Two ways in:

```bash
# Write the merged multi-source store back out in Last.fm CSV shape, so the
# EXISTING pipeline consumes it with no changes:
venv/Scripts/python.exe -m ingest.cli export-csv --out data/plays.csv
venv/Scripts/python.exe -m pipeline.build --csv data/plays.csv
```

or, in Python, `ingest.groups.load_groups_from_store(store)` returns the exact
`(list[AlbumGroup], stats)` shape `pipeline.build` expects.

Sub-threshold plays are dropped by `export-csv`, because the CSV has nowhere to
record `ms_played` and a consumer could not apply the rule itself.

## Commands

```bash
venv/Scripts/python.exe -m ingest.cli status          # what is stored, where each cursor sits
venv/Scripts/python.exe -m ingest.cli csv    --path data/scrobbles.csv
venv/Scripts/python.exe -m ingest.cli lastfm --user <name> [--full]
venv/Scripts/python.exe -m ingest.cli spotify-export --path <zip|dir|json>
venv/Scripts/python.exe -m ingest.cli spotify-poll   --token <access token> [--watch]
venv/Scripts/python.exe -m ingest.cli export-csv --out data/plays.csv
venv/Scripts/python.exe -m ingest.cli groups          # preview album groups
venv/Scripts/python.exe -m pytest ingest/tests -q
```

## Credentials

Nothing is committed. `.env.example` at the repo root documents every name and
where to get it. **There is deliberately no client secret anywhere** — PKCE
exists so none has to ship.

### What you have to do yourself for Spotify sign-in

Claude cannot do any of this; it requires your account.

1. https://developer.spotify.com/dashboard → **Create app**.
2. Redirect URI **exactly** `crates://auth` (matches `app.json`'s `scheme`).
3. Which API: **Web API**.
4. Copy the Client ID into `SPOTIFY_CLIENT_ID` and
   `EXPO_PUBLIC_SPOTIFY_CLIENT_ID` in `.env`.
5. **Settings → User Management: add the email of every Spotify account that
   will sign in, including your own.** Up to 25. Anyone not on the list gets an
   opaque failure.

Until step 4 is done the app disables the Spotify button and explains why,
rather than failing at tap time.

**And the part that does not have a workaround:** this path cannot be shipped on
the App Store. Development Mode's 25-user allowlist would not include App
Review's own tester account, so the reviewer sees a broken login — a Guideline
2.1 rejection. Extended Quota Mode has been organizations-only since May 2025
and requires 250,000+ MAU. There is no rung between those two. Spotify sign-in
is a real, working feature for you and up to 24 friends; Last.fm is the one that
ships.
