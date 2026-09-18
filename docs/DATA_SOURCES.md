# Crates — live listening data sources

Workstream 3 research. Current as of 2026-09-17. Spotify's developer terms
changed materially in May 2025, February 2026 and July 2026 — re-verify before
building on any of this.

## TL;DR

- **Spotify's Web API cannot give you listening history.** `recently-played`
  is capped at the **last 50 tracks, full stop** — the pagination cursors move
  *within* that 50-item window and then return empty. There is no historical
  endpoint. This is a hard blocker for a retrospective collection app.
- **Spotify's Extended Streaming History GDPR export *does* have full history**,
  but it is a manual, per-user, up-to-30-day zip download. It cannot be
  automated and it is not an API. It is fine for you; it is unusable as an
  onboarding flow for a stranger.
- **Shipping a public App Store app on Spotify's API is effectively closed to
  you.** Development mode caps you at a small allowlist of users; Extended
  Quota mode requires a registered company with **250,000+ MAU**. Individuals
  have not been accepted since May 2025. There is no ladder between those two
  rungs. **This is a hard blocker, not a hurdle.**
- **Last.fm is the answer.** It already holds the user's full scrobble history,
  `user.getRecentTracks` paginates back to the beginning of time, it needs only
  an API key and a username, and any Spotify/Apple Music user can start
  scrobbling in a few minutes. Its one real constraint is that commercial use
  requires a separate agreement.
- **Recommendation: build on Last.fm, keep the CSV importer as a fallback,
  treat Spotify as display-only enrichment or skip it entirely.**

---

## 1. Spotify Web API

### What endpoints exist for listening history

| Endpoint | What it gives | Real limit |
|---|---|---|
| `GET /v1/me/player/recently-played` | Recent play events with timestamps | **~50 items total**, `limit` max 50 per request |
| `GET /v1/me/top/tracks` and `/top/artists` | Ranked favourites | `short_term` (~4 weeks), `medium_term` (~6 months), `long_term` (years), max 50 items, **no timestamps, no play counts** |
| `GET /v1/me/player/currently-playing` | What's playing now | Point-in-time only |
| `GET /v1/albums/{id}` | **Canonical tracklists** | Fine, and genuinely useful |
| `GET /v1/search`, `/artists/{id}` | Metadata, cover art, artist genres | Fine |

### The recently-played cap, precisely

The documented `limit` parameter maxes at 50 per request, and the response
carries `before`/`after` cursors that accept Unix millisecond timestamps. It
*looks* paginable. It is not. The cursors only traverse the ~50-item buffer
Spotify retains; paging past it returns an empty `items` array. This has been
the observed behaviour since 2018 and is tracked in Spotify's own issue
tracker. Once you play a 51st track, the oldest is gone permanently.

Practical consequence: to build history from the Web API you would have to poll
`recently-played` on a schedule, forever, and keep your own database. That
works — it is how every scrobbler works — but:

- It only accumulates history **from the day you start**. The user's past is
  unrecoverable. For Crates, whose entire premise is a 6-year back catalogue of
  completed albums, a from-zero start is close to worthless on day one.
- It requires a **server** running polls with refresh tokens. That is no longer
  a client-only app; it is infrastructure you must host, secure and pay for.
- Missed polls lose plays. A user who streams 60 tracks between polls loses the
  overflow.

**Verdict: full listening history is not obtainable from the Spotify Web API.
Say this plainly — it is not a matter of finding the right endpoint.**

### Extended Streaming History (GDPR export)

Requested from Spotify account → Privacy settings. Note there are **two
separate requests**: the standard "Account data" (which only includes the last
year of streaming) and the **"Extended streaming history"**, which is the one
you want — all-time play events with `ts`, `master_metadata_track_name`,
`master_metadata_album_artist_name`, `master_metadata_album_album_name`,
`ms_played`, `reason_start`/`reason_end`, `skipped`, and more.

- Format: a zip of JSON files, each ~12 MB, plus a PDF describing the schema.
- Delivery: officially **up to 30 days** (the GDPR Article 15 limit). In
  practice typically 1–5 days, occasionally hours.
- `ms_played` is a genuine advantage over Last.fm — you can distinguish a real
  listen from a 3-second skip, which matters for an "every track played"
  unlock rule.

**How it fits:** it is an excellent *one-off import*, for you or for a
motivated user. It is a terrible *product mechanic*: "to use this app, go to
Spotify's website, file a data request, wait up to a month, then upload a zip"
is not an onboarding flow anyone completes. Support it as an optional power-user
importer; never depend on it.

### Developer terms — the part that actually decides this

**Quota modes.** A newly-created Spotify app starts in **Development Mode**.
Only a small, explicitly allowlisted set of authenticated Spotify users may use
it — Spotify raised this to **25 users** alongside the July 2026 changes (older
docs still say 5 in places; treat 25 as the current figure and verify in your
own dashboard, since the number has moved). Every user must be added by hand in
the developer dashboard by email. As of the July 2026 update, quota is counted
**per developer account, not per Client ID** — creating more apps does not
create more capacity. You may hold up to 25 Client IDs, all sharing one budget.

**Extended Quota Mode** removes the allowlist and the user cap. To get it:

- Applications are accepted **only from organizations, not individuals**
  (policy in force since 15 May 2025).
- You must be an established, legally registered business entity.
- With an **active, launched service**.
- With a minimum of **250,000 monthly active users**.
- Available in key Spotify markets, commercially viable, terms-compliant.
- Review takes up to six weeks.

Read that ordering carefully: you are capped at 25 users, and to escape the cap
you must already have 250,000. There is no bridge. Developers have raised this
in Spotify's own community forums and it is not a misreading.

**So: can an App Store app be built on it?** Technically an app in Development
Mode can be *listed* on the App Store — but only ~25 allowlisted people could
ever sign in, and **App Review's own tester account would not be on the
allowlist**, so the reviewer sees a broken login. That is a Guideline 2.1 /
5.2.2 rejection (see `DISTRIBUTION.md` §6). **Treat a publicly-distributed
Spotify-authenticated app as impossible for an individual developer.**

**Rules about displaying and combining Spotify data.** Even setting quota
aside, the Developer Policy constrains what Crates wants to do:

- You must **attribute content to Spotify using the Spotify Marks**, and any
  metadata or cover art must carry a **link back to that album/track on
  Spotify**.
- You may not offer **metadata, cover art or audio preview clips as a
  standalone service or product**. An app that is a wall of album covers and
  derived stats sits uncomfortably close to this.
- You may not build a product that **connects with streams or content from
  another service** — i.e. blending Spotify data with Apple Music or Last.fm
  data in one view is contrary to the policy.
- You may not create **new or derived listenership metrics** from analysing
  Spotify content or the Spotify service. "Album completion percentage" is
  arguably exactly a derived listenership metric. This is a real, non-theatrical
  risk for Crates' core mechanic.
- You may not use Spotify Content to **train or ingest into a machine learning
  or AI model** (Policy III.14, since 15 May 2025).
- Naming/branding: don't start the name with "Spot", don't imply endorsement.

**Where Spotify is still safely useful:** as a *catalogue* source — resolving
tracklists, release years and cover art for albums, with proper attribution and
links back — rather than as a source of the user's listening history. That use
fits within Development Mode's quota because catalogue endpoints use the
Client Credentials flow with no per-user authentication.

## 2. Last.fm API

Scrobbles are already flowing here. That is the whole argument, but here it is
assessed properly.

**What it gives:**

- `user.getRecentTracks` — the user's complete scrobble history, paginated,
  with `from`/`to` Unix timestamp filters, up to 200 per page. It genuinely
  goes back to the account's first scrobble. This is the endpoint the 136,512-row
  CSV in `data/` is an export of.
- `user.getInfo` for total playcount and registration date.
- `album.getInfo` for tracklists and tags, `artist.getTopTags` for genre
  signal — directly useful to the `pipeline/` workstream.
- Public profiles need only an **API key** — no OAuth, no user token, no
  allowlist. The user types their username and you are done.

**Limits and constraints, honestly:**

- **Rate limit:** informally ~1 request/second sustained, and Last.fm "sets and
  enforces limits on use of the API to prevent abuse." Backfilling 136k
  scrobbles at 200/page is ~680 requests — about 12 minutes. Acceptable once,
  then incremental `from=` polls are trivial.
- **Commercial use requires a separate agreement** (API ToS Clause 3.1;
  contact `partners@last.fm`). A free app with no monetization is defensible as
  non-commercial; the moment you add IAP, subscriptions or ads you need that
  agreement. Get it in writing before monetizing.
- **Attribution required** — credit Last.fm and use the "powered by
  AudioScrobbler" branding.
- **Storage cap:** the ToS specifies a "Reasonable Usage Cap" of **100 MB** of
  stored Last.fm Data. On-device per-user caches are fine; a server-side
  warehouse of everyone's scrobbles is not.
- **No sublicensing**, no using the data to identify or contact users.
- **Data quality is the real weakness**, and the SPEC already documents it:
  messy album names, variant artist names, mbid fill rates of 64–72%, no
  tracklists, no genres. Everything the `pipeline/` workstream is doing exists
  because Last.fm data is dirty.
- Scrobbles have **no duration** — you cannot tell a full listen from a skip,
  unlike Spotify's `ms_played`. For an "every track played" unlock, this makes
  the rule slightly more generous than ideal. Acceptable.
- **Requires the user to scrobble.** Someone who has never used Last.fm has no
  history to import — but they can connect Spotify to Last.fm in about three
  minutes and start accumulating, and Last.fm can also import from
  Spotify/Apple Music via Spotify's built-in integration.

**Against Spotify:** Last.fm loses on data cleanliness and on `ms_played`. It
wins on *everything that determines whether this app can exist* — full history,
no user cap, no corporate-entity requirement, no 250k MAU gate, a permissive
key-only auth model, and no policy clause forbidding derived listening metrics.
It is not close.

## 3. Apple Music / MusicKit

- `GET /v1/me/recent/played/tracks` returns **at most 50 recently-played
  items**, and the endpoint only accepts `limit` values of **1–10** per request
  (larger values error), so you page with `offset=0,10,20,30,40`. Same shape of
  problem as Spotify, same fatal flaw: **no historical listening data.**
- The user's **library** is fully readable (`/v1/me/library/...`) — albums,
  songs, playlists, date added. That tells you what they *own or saved*, not
  what they *played*. Crates is about plays, so this is the wrong axis.
- Play counts are not exposed. Apple's own Replay is computed server-side and
  not available via the API.
- Requires the same $99/yr Apple Developer Program membership (which you are
  buying anyway), a MusicKit identifier and a private key to mint developer
  tokens, plus a **user token** requiring an active Apple Music subscription.
- Platform-native, no allowlist, no MAU gate — the terms are genuinely more
  permissive than Spotify's. But the data simply isn't there.

**Verdict: not viable as the history source.** Worth keeping in mind only as a
future "play this album" deep-link on iOS, where MusicKit is the natural fit.

## 4. Recommendation

**Build on the Last.fm API. Make the CSV importer a fallback, not the primary
path. Do not architect around Spotify.**

Reasoning:

1. **It is the only option that supplies full history.** Spotify: 50 tracks.
   Apple Music: 50 tracks. Last.fm: all 136,512 and counting. Crates is a
   retrospective collection app; a source that starts at zero defeats it.
2. **It is the only option a non-corporate developer can ship publicly.**
   Spotify's 25-user allowlist / 250k-MAU cliff is a hard blocker for App Store
   distribution, and it will fail App Review on the reviewer's own account.
3. **It requires no server.** API key plus username; the app can fetch and
   cache on-device. Spotify's polling approach would force you into hosting,
   token refresh and a database.
4. **Its policy doesn't forbid the core mechanic.** Spotify's prohibition on
   derived listenership metrics and on combining with other services is aimed
   squarely at what Crates does.
5. **The data already exists.** The user is scrobbling today.

### Concrete architecture

- Keep `data/collection.json` as the contract exactly as SPEC defines it.
- Replace the static CSV read with a Last.fm sync: `user.getRecentTracks` with
  `from=<last seen uts>`, paged at 200, run on app open. Persist the cursor.
- Keep the CSV importer for cold-start bulk load — it is faster than 680 API
  calls and it's the export the user already has.
- Enrichment (tracklists, genres, cover art) stays where the `pipeline/`
  workstream has it: **MusicBrainz + Cover Art Archive**, which are open-licensed
  and have none of these restrictions. Prefer these over Spotify catalogue
  calls; it avoids the attribution/link-back obligations entirely.
- Optional power-user path: import a Spotify Extended Streaming History zip for
  `ms_played` precision. Clearly labelled as optional, never the onboarding.

### What this means for a user who is not the developer

This is the question that decides whether Crates is shippable, so be explicit:

- **Onboarding is: "enter your Last.fm username."** That is it. No OAuth, no
  allowlist, no approval from anyone. This is what makes App Store distribution
  possible at all.
- A user with an existing Last.fm account gets their full history immediately
  and a populated shelf on first launch. **That is the good case and it is a
  genuinely good first-run experience.**
- A user *without* Last.fm gets an empty shelf. They must create a free Last.fm
  account and connect Spotify or Apple Music to it, then wait weeks or months
  for crates to fill. **Be honest in the UI about this** — frame the empty state
  as "your first crate is X plays away," not as a broken app. Accept that
  Crates is, structurally, an app for people who scrobble.
- Privacy: Last.fm profiles are public by default, so the app reads public data
  and needn't store credentials. Say so on the App Privacy label — it is a
  clean, easily-defended answer.
- If you ever monetize, get the Last.fm commercial agreement first
  (`partners@last.fm`). Guideline 5.2.2 means Apple can ask.

### Hard blockers, restated

| Claim | Status |
|---|---|
| Get full listening history from Spotify's Web API | **Impossible.** 50-track cap, no historical endpoint. |
| Automate the Spotify GDPR extended history export | **Impossible.** Manual request, up to 30-day wait, no API. |
| Ship a public App Store app with Spotify user login as an individual dev | **Impossible.** Dev-mode allowlist; Extended Quota needs a company with 250k MAU; individuals not accepted since May 2025. |
| Get play history (not library) from Apple Music | **Impossible beyond the last 50 tracks.** |
| Get full history from Last.fm with a plain API key | **Works today.** |

## Sources

- [Spotify — Get Recently Played Tracks](https://developer.spotify.com/documentation/web-api/reference/get-recently-played)
- [Spotify web-api issue #1405 — recently-played paging](https://github.com/spotify/web-api/issues/1405)
- [Spotify — Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
- [Spotify — Apps concept](https://developer.spotify.com/documentation/web-api/concepts/apps)
- [Spotify blog — Web API quota updates for Development Mode (2026-07-23)](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates)
- [Spotify — February 2026 Web API Dev Mode migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- [Spotify Developer Terms](https://developer.spotify.com/terms)
- [Spotify Developer Policy](https://developer.spotify.com/policy)
- [Spotify — GDPR Article 15 information](https://www.spotify.com/legal/gdpr-article-15-information)
- [Last.fm API Terms of Service](https://www.last.fm/api/tos)
- [Last.fm — user.getRecentTracks](https://www.last.fm/api/show/user.getRecentTracks)
- [Apple Music API — Get Recently Played Tracks](https://developer.apple.com/documentation/applemusicapi/get-v1-me-recent-played-tracks)
- [Apple Developer Forums — MusicKit recent items 30/50 item limit](https://developer.apple.com/forums/thread/735988)
- [App Review Guidelines (5.2.2 Third-Party Services)](https://developer.apple.com/app-store/review/guidelines/)
