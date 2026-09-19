# Rewards — build spec

The shelf is the home screen. Rewards are how it becomes *yours*: stickers and
posters earned by listening, and access to per-artist communities gated by how
much you have actually listened.

Decisions already made: **Supabase** backend, a **custom admin dashboard** for
authoring rules, **placeholder art** for now, and a first milestone of **the
rule engine plus stickers**. Chat is modelled as a reward in milestone 1 but not
built.

---

## 1. The core idea: rule *types* are code, rules are *data*

A small, fixed set of rule **types** is implemented in code. Every actual rule is
a **row** that an admin creates, edits, toggles and retires without a deploy.

| type | target | threshold | reward | active |
|---|---|---|---|---|
| `artist_plays` | Blink-182 | **182** | sticker: *blink-bunny* | ✓ |
| `artist_plays` | Sum 41 | **41** | sticker: *sum41-skull* | ✓ |
| `artist_plays` | *any artist* | 100 | community access *(per artist)* | ✓ |
| `album_passes` | *any album* | 5 | poster *(per album)* | ✓ |

- **Tuning** a rule (threshold, reward, on/off, a date window) is a row edit.
- **A new kind** of rule ("played between midnight and 4am") is a new type in
  code. That is deliberate. Types are where the logic lives, and logic belongs in
  code review, not in a form field.

Band-specific numbers need no special machinery: Blink-182 at 182 is an ordinary
`artist_plays` rule with a threshold that means something to the fans.

### Rule types, v1

| type | params | earned when |
|---|---|---|
| `artist_plays` | `artist` (MBID or `*`), `threshold` | the user has ≥ `threshold` plays of the artist |
| `album_unlocked` | `album` (release MBID or `*`) | every track on the album has been played at least once |
| `album_passes` | `album` (MBID or `*`), `threshold` | every track on the album has been played ≥ `threshold` times — see §6 |
| `artist_albums_unlocked` | `artist` (MBID or `*`), `threshold` | ≥ `threshold` of that artist's albums are unlocked |
| `albums_unlocked` | `threshold` | ≥ `threshold` albums unlocked in total |

### Wildcards grant *per-subject* rewards

`artist_plays · * · 100 → community access` must grant **the Radiohead
community** for Radiohead plays and **the Nujabes community** for Nujabes plays,
not one global "community" reward. So a wildcard rule points at a reward
**template**. Each grant is recorded against the specific artist or album that
earned it (its *subject*), and the sticker art and community resolve from that
subject.

---

## 2. Trust model: who is allowed to decide a reward was earned

Rewards come in two kinds that need different levels of trust.

| | cheating hurts… | evaluated | plays come from |
|---|---|---|---|
| **Cosmetic** (sticker, poster) | only the cheater | server, but tolerance is fine | server fetch |
| **Access** (community) | *other people's space* | **server only** | **server fetch only** |

Rules this imposes:

1. **The server fetches plays itself** from Last.fm or Spotify. It never accepts
   play counts uploaded by the app. The app is untrusted, because anyone can edit
   local data.
2. **`user_rewards` is written only by the server** (service role). Row-level
   security denies every client insert or update on it, without exception.
3. **Account ownership must be proven before plays count.** Last.fm profiles are
   public: without proof, anyone could type in someone else's username and inherit
   their history. Last.fm proves ownership through its **web-auth flow**
   (`auth.getSession` returns a session key bound to the account that approved
   it). Spotify's OAuth proves ownership by construction.

This reverses the earlier "keep plays on the device" advice. That was right for
a single-player shelf. It stops being right the moment a reward controls access
to a space other people are in.

**Secrets.** Last.fm's shared secret signs web-auth requests, so it lives only in
Supabase Edge Function secrets. It never ships in the app or appears in the repo.

---

## 3. Schema (Postgres)

```
profiles          id (= auth.users.id), display_name, created_at
admins            user_id                       -- who may use the dashboard

linked_accounts   user_id, provider ('lastfm'|'spotify'), external_id,
                  verified_at, session_key (server-only), cursor, last_synced_at
                  unique (provider, external_id)   -- one account, one owner

artists           id, mbid (unique), name
albums            id, release_mbid (unique), artist_id, title, tracklist jsonb,
                  cover_url, colors jsonb, fetched_at     -- the shared catalog

artist_plays      user_id, artist_id, plays, updated_at          pk(user, artist)
track_plays       user_id, album_id, track_key, plays            pk(user, album, track)

rewards           id, kind ('sticker'|'poster'|'community'), name, description,
                  art_url, subject_kind ('artist'|'album'|null), artist_id, album_id
rules             id, type, params jsonb, reward_id, active, starts_at, ends_at,
                  notes, updated_by, updated_at
user_rewards      user_id, reward_id, subject_id, rule_id, granted_at, evidence jsonb
                  pk(user_id, reward_id, subject_id)       -- idempotent grants
```

The `unique (provider, external_id)` constraint on `linked_accounts` stops two
users from claiming the same Last.fm account.

`evidence` records *why* a reward was granted (for example `{"plays": 184,
"threshold": 182}`), so a disputed grant can be explained later.

### Row-level security

| table | client read | client write |
|---|---|---|
| `rules`, `rewards`, `artists`, `albums` | everyone | admins only |
| `profiles`, `linked_accounts` | own row | own profile only; **never** `verified_at` or `session_key` |
| `artist_plays`, `track_plays` | own rows | **none** — server only |
| `user_rewards` | own rows | **none** — server only |

---

## 4. Evaluation

- **When:** after each server-side sync of a user's plays, and for everyone
  whenever an admin saves a rule.
- **Idempotent:** grants are upserts on `(user, reward, subject)`. Running the
  evaluator twice, or a hundred times, never double-grants.
- **Rules are pure functions** of the aggregates, so they can be unit-tested
  without a database.
- **Retroactive when loosened:** lowering a threshold grants the new reward to
  everyone who now qualifies.
- **Never revoked when tightened:** raising a threshold, deactivating a rule or
  ending its date window stops *new* grants but keeps existing ones. Taking away
  something a person earned is the fastest way to make a reward feel worthless.
  *(Default. Revisit only deliberately.)*

---

## 5. Admin dashboard

A separate web app in `admin/`, never bundled into the mobile app.

- Sign in; only users in `admins` get past the door.
- **Rules list**: filter by type or artist, an active toggle per row.
- **Rule editor**: pick a type, then fill only the fields that type needs.
  Artist and album search against the catalog/MusicBrainz, a threshold, and a
  reward picker.
- **Dry run before save:** "*412 users qualify; 38 would receive it for the first
  time.*" This is the most important feature on the page. It is what makes
  changing a threshold safe.
- **Rewards catalog**: create stickers, posters and community rewards, and upload
  art (Supabase Storage).
- An audit trail through `updated_by` / `updated_at` on every rule.

---

## 6. Open definition: what "listened to an album five times" means

This changes the computation, so it is written down rather than assumed.

**Chosen: an album pass count = the *minimum* play count across its tracks.**
Every track played at least 5 times means 5 passes. It is computable from play
counts alone, it matches the existing unlock rule (1 pass = unlocked), and it
cannot be gamed by replaying only the single.

**Rejected: five sequential start-to-finish listening sessions.** That needs
session detection, breaks on shuffle, and misfires on a skipped interlude. It is
harder to explain to a user and harder to make fair.

---

## 7. Milestone 1 — engine + stickers

Sequenced so the first real reward arrives as early as possible:

**1a — artist rules (no catalog dependency)**
- Supabase schema, RLS, and migrations.
- Last.fm web-auth ownership proof (Edge Function).
- Server-side sync → `artist_plays`.
- Rule evaluator for `artist_plays`, with unit tests.
- Admin dashboard: rules, rewards, dry run.
- Placeholder sticker art, generated.
- App: sign in, see earned stickers on the shelf.

**1b — album rules**
- Move the album catalog from `pipeline/.cache/albums.sqlite3` into Postgres
  (`albums` table; see `docs/CATALOG.md`). Album rules need tracklists on the
  server, and 1a does not, which is why this comes second.
- `track_plays` aggregation.
- `album_unlocked`, `album_passes`, `artist_albums_unlocked`, `albums_unlocked`.

**Not in milestone 1:** chat, sticker placement on crates (milestone 2),
real art, Spotify-verified sync at scale (25-user cap, see `DATA_SOURCES.md`).

---

## 8. Things only the user can do

- Create the Supabase project (free tier is enough for development).
- `supabase login`, which opens a browser device flow, the same pattern as `gh`.
- Put the Last.fm **shared secret** into Supabase secrets. Do not paste it into
  chat; it signs requests as the app.
- Before App Store submission: if any third-party sign-in is offered, **Sign in
  with Apple** must be offered too (App Store Guideline 4.8). Email magic links
  alone do not trigger that requirement.
- Before chat ships: App Store Guideline 1.2 obligations for user-generated
  content (filtering, report, block, acting on reports).

---

## 9. Contracts between the pieces

Everything below is an Edge Function at
`https://<ref>.supabase.co/functions/v1/<name>`. Callers send the user's JWT as
`Authorization: Bearer <jwt>` plus the publishable key as `apikey`.

### Last.fm ownership and sync

| function | caller | request | response |
|---|---|---|---|
| `lastfm-auth-start` | signed-in user | `POST {}` | `{ "url": string }` (open it in a browser) |
| `lastfm-auth-complete` | Last.fm's redirect | `GET ?token=…&state=…` | `302` → `milk://auth/lastfm?status=ok` or `?status=error&reason=<code>` |
| `lastfm-sync` | signed-in user | `POST {}` | `{ "done": bool, "pages_processed": int, "plays_added": int, "granted": int }` |

- `state` is a nonce from `lastfm_auth_states`: single-use, 10-minute expiry,
  bound to the user who called `lastfm-auth-start`.
- `lastfm-auth-complete` refuses an account that another Milk user already owns
  (`reason=already_linked`). It never moves the account to the new user.
- `lastfm-sync` is **resumable**. Edge Functions have a wall-clock limit, and a
  first backfill can run to hundreds of pages. Each call processes a bounded
  chunk and returns `done: false` until it has finished; callers keep calling
  until they get `done: true`.
- Play counts must be **exact**. An overlap between two syncs must never count
  a play twice.

`reason` codes: `bad_state`, `expired_state`, `already_linked`,
`lastfm_rejected`, `server_error`.

### Rules

| function | caller | request | response |
|---|---|---|---|
| `rules-dry-run` | admin | `POST { "rule": { "type", "params", "reward_id" } }` | see below |
| `rules-evaluate` | admin, or the server | `POST { "rule_id"?: uuid, "user_id"?: uuid }` | `{ "evaluated_users": int, "granted": int, "skipped_rules": [ { "rule_id": uuid, "error": string } ] }` |

```json
{
  "qualifying_users": 412,
  "new_grants": 38,
  "already_granted": 374,
  "subjects": 51,
  "sample": [ { "subject_key": "<mbid>", "subject_name": "Radiohead", "users": 17 } ]
}
```

- A dry run **never writes**.
- `rules-evaluate` called with neither id evaluates every rule for every user.
- Server code calls the shared evaluator directly, not over HTTP:
  `evaluateUser(db, userId): Promise<{ granted: number }>`, exported from
  `supabase/functions/_shared/rules/evaluate.ts`.
- Grants are upserts on `(user_id, reward_id, subject_key)`. The evaluator
  **never** deletes a grant.

**Errors.** Both functions return `{ "error": string }` on failure. The message
is written for a human and the dashboard shows it verbatim.

| status | meaning |
|---|---|
| 400 | malformed rule or request body |
| 401 | no session, or an invalid or expired one |
| 403 | signed in, but not in `admins` |
| 404 | `rules-evaluate` was given a `rule_id` that does not exist |

**`skipped_rules`.** When `rules-evaluate` runs several rules, a malformed rule
is skipped and listed here, so the other rules still grant. When it is asked for
exactly one `rule_id` and that rule is malformed, it returns 400 instead.

**Dry-run counting.** `qualifying_users` counts users. `new_grants` and
`already_granted` count **(user, subject) grants**, not users. For a
non-wildcard rule the two are the same thing. For a wildcard rule they can
exceed `qualifying_users`, because one user can qualify for several artists or
albums. `subjects` is the number of distinct subjects with at least one
qualifying user. `sample` lists up to 10 of them, most users first.
`subject_name` is the artist name or album title, or `null` when `subject_key`
is `''` (`albums_unlocked`). The dry run ignores `active`, `starts_at` and
`ends_at`: it answers "who meets this rule", whatever the rule's schedule.

**Date window.** `starts_at` and `ends_at` apply to *when the evaluation runs*.
A rule grants only while `active` and `starts_at <= now < ends_at`, where either
bound may be null. Aggregates are all-time counts with no timestamps, so a
window on *when the plays happened* is not computable from them. Such a rule
would be a new rule type.

**Params, per type.** Any key not listed for a type is rejected, which catches
typos.

| type | params |
|---|---|
| `artist_plays` | `artist`, `threshold` |
| `album_unlocked` | `album` (no threshold: it means one full pass; use `album_passes` for N) |
| `album_passes` | `album`, `threshold` |
| `artist_albums_unlocked` | `artist`, `threshold` |
| `albums_unlocked` | `threshold` |

- `artist`: a lowercase artist MBID, `"name:<artistKey>"`, or `"*"`.
- `album`: a lowercase release MBID, or `"*"`. Albums have no `name:` keys.
- `threshold`: a JSON integer from 1 to 1,000,000. A string such as `"100"` is
  rejected.

**Reward compatibility.** A wildcard rule grants one reward *per subject*, so
its reward must be a per-subject **template**: `subject_kind` matching the rule
type (`artist` for the artist types, `album` for the album types) and no
`artist_id` or `album_id`. A non-wildcard rule may use a plain reward or a
template of its own subject kind. `albums_unlocked` has no subject, so it cannot
use a template.

**`subject_key`.** For the artist types it is `artists.mbid` (a real MBID or
`name:<artistKey>`). For the album types it is `albums.release_mbid`. For
`albums_unlocked` it is `''`.

**Enforced in the database.** The `rules_validate` trigger (migration
`20260919010000_rules_validate.sql`) applies every check above on INSERT or
UPDATE of `public.rules`. So a malformed rule cannot be saved even by a client
that skips the dry run. Its messages match the functions' 400 messages, and they
reach the client as the PostgREST error `message` with SQLSTATE `22023`. The
TypeScript source of truth is `supabase/functions/_shared/rules/validate.ts`.
Change the two together.

### Artists without a MusicBrainz id

About 28% of scrobbles carry no artist MBID, and `artists.mbid` is `NOT NULL`.
Those artists get a synthetic key, `name:<artistKey>`, where `artistKey` is the
output of the existing normalizer (`app/src/link/normalize.ts`, which agrees with
the Python pipeline on 22 of 22 test cases). Rules can target them the same way
as any other artist.
