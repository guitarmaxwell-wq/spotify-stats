# Where album data and artwork come from

Decision record. Answers: "do we need our own database of every album, or can we
pull from somewhere online?"

## The short answer

Both, but not how it sounds. We do **not** mirror a catalog of every album ever
released — that is 5.78M releases in MusicBrainz alone and it would be stale the
day we shipped. We pull from upstream sources on demand, and we keep a **cache**
of only the albums our users have actually touched.

The cache is a performance and rate-limit layer, not a catalog. 1,000 users who
all played *Donuts* should cost one upstream lookup, not a thousand.

## Sources, and what each is for

| Need | Source | Why |
|---|---|---|
| Canonical tracklist ("what exists") | **MusicBrainz** | The only free source with complete tracklists and an open license. Already in use. 5.78M releases. |
| Artwork, primary | **Cover Art Archive** | Tied to MusicBrainz release MBIDs, so it needs no separate matching. Free, no usage restrictions. Covers **3,837,189 of 5,784,574 releases — 66.3%**. |
| Artwork, fallback | **Deezer public API** | Keyless, no OAuth, ~50 req/5s. Covers much of the third that CAA misses, especially recent mainstream releases. |
| Listening history | **Last.fm** (see DATA_SOURCES.md) | Full history from a username. |

## Why NOT Spotify for artwork or catalog

Spotify has the best artwork coverage of anything available, and we still should
not use it. Their Developer Terms:

- Cover art may only be **temporarily cached** "to enhance performance" — persistent
  storage is not permitted. A shelf is persistent by definition.
- You **must not modify, crop or adjust artwork**. Deriving a dominant-color
  gradient from a Spotify image is exactly the kind of derivation this forbids.
- Every use of metadata or cover art must carry **attribution linking back to
  Spotify**, and must not be offered as a standalone product.

Using Spotify artwork would put the core visual identity of the app on a licence
we cannot satisfy. CAA and Deezer have no such constraints.

Spotify remains in scope for *listening history* only (see below).

## The cache

Server-side, keyed by MusicBrainz release MBID:

- tracklist, title, artist, year, genre tags
- artwork URL + our extracted dominant colors (see the gradient work)
- `fetched_at`, so entries can be refreshed on a TTL rather than never

Rules:
- Populate lazily. An album enters the cache the first time any user plays it.
- Never store Spotify-derived fields in it.
- Artwork: store the URL and our derived colors. Bytes can be re-fetched or CDN'd.

## Freshness

New releases appear in MusicBrainz within days, usually faster in Deezer. A
per-album TTL (say 30 days) plus a "resolve on first play" path means a record
released this morning is resolvable this afternoon without us running a crawler.
