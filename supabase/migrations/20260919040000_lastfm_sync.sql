-- Last.fm ownership proof and server-side play sync (docs/REWARDS.md section 9).
--
-- Everything here is SERVER ONLY. Each table has RLS enabled and no client
-- policies; each function has EXECUTE revoked from public/anon/authenticated
-- and granted to service_role alone. A function in `public` is otherwise
-- callable by anyone holding the publishable key, through PostgREST's /rpc.
--
-- ------------------------------------------------------------------------
-- Why a raw-plays ledger exists (lastfm_scrobbles)
-- ------------------------------------------------------------------------
-- artist_plays holds aggregates, and aggregates cannot be de-duplicated after
-- the fact. Exactness therefore needs a record of WHICH scrobbles were counted,
-- for three reasons that a cursor alone cannot handle:
--
-- 1. Late scrobbles. Offline scrobblers upload plays with timestamps up to two
--    weeks old. A strictly-exclusive cursor never sees them (undercount); a
--    look-back window sees them, but also re-sees everything else in the window
--    (overcount) -- unless each scrobble is recognised as already counted.
-- 2. Boundary ties. Several scrobbles can share a second. Last.fm's `to` is
--    exclusive, so a walk that advances by timestamp must re-read the boundary
--    second to avoid dropping a tie, and must then not count it twice.
-- 3. Resumable walks. A first backfill (693 pages here) spans many calls and
--    many minutes; anything that lands in the window between calls shifts
--    page boundaries.
--
-- With the ledger, counting is: a scrobble counts iff its identity row is new.
-- artist_plays is then DERIVED from the ledger (lastfm_recompute_artist_plays),
-- so it is always a partition of the ledger: every counted scrobble is in
-- exactly one artist's total, and sum(artist_plays.plays) = ledger row count.
--
-- Scrobble identity is (user, uts, artist name, track name) as Last.fm returns
-- them. The two names are folded into an md5 so the key stays fixed-width.

create table public.lastfm_scrobbles (
  user_id     uuid   not null references auth.users (id) on delete cascade,
  uts         bigint not null,
  -- md5(artist_name || E'\n' || track_name)::uuid. Computed by the ingest
  -- function, never by a client.
  fp          uuid   not null,
  artist_name text   not null,
  -- artistKey(artist_name) from supabase/functions/_shared/lastfm/normalize.ts.
  artist_key  text   not null,
  -- The artist MBID Last.fm attached to THIS scrobble, lower-cased, or null.
  artist_mbid text,
  inserted_at timestamptz not null default now(),
  primary key (user_id, uts, fp)
);

create index lastfm_scrobbles_user_key_idx on public.lastfm_scrobbles (user_id, artist_key);

-- Progress of the (resumable) sync for one linked account.
--
-- A sync covers the half-open window [sync_from, sync_to) (Last.fm: `from` is
-- inclusive, `to` exclusive). It walks newest-first by shrinking `to`:
-- everything in [walk_to, sync_to) is already in the ledger. When the walk
-- finishes, cursor_ts := sync_to, and the next sync starts at
-- cursor_ts - look-back so late scrobbles are picked up.
create table public.lastfm_sync_state (
  linked_account_id uuid primary key references public.linked_accounts (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  cursor_ts         bigint,
  sync_from         bigint,
  sync_to           bigint,
  walk_to           bigint,
  walk_page         integer,
  -- One sync call at a time per account, to be polite to Last.fm. Correctness
  -- does not depend on it (ingest is compare-and-set); request volume does.
  lease_until       timestamptz,
  updated_at        timestamptz not null default now(),
  check ((sync_to is null) = (walk_to is null) and (sync_to is null) = (walk_page is null))
);

-- artistKey(artists.name) for catalog artists with a REAL MBID. The key is
-- computed in TypeScript (the normalizer is not SQL), so the sync backfills
-- rows here for any artist that lacks one, whoever inserted the artist.
-- A side table rather than a column so the core `artists` table is untouched.
create table public.artist_name_keys (
  artist_id uuid not null references public.artists (id) on delete cascade,
  name_key  text not null,
  primary key (artist_id, name_key)
);

create index artist_name_keys_key_idx on public.artist_name_keys (name_key);

alter table public.lastfm_scrobbles  enable row level security;
alter table public.lastfm_sync_state enable row level security;
alter table public.artist_name_keys  enable row level security;

-- ------------------------------------------------------------------ auth --

-- Consume a web-auth nonce. Atomic: the UPDATE takes the row lock, and a
-- concurrent second UPDATE re-checks `used_at is null` after the first commits
-- (READ COMMITTED re-evaluation), finds it false and updates nothing. Exactly
-- one caller ever gets status 'ok' for a nonce. Uses the database clock.
create or replace function public.lastfm_consume_state(p_nonce text)
returns table (user_id uuid, status text)
language plpgsql
set search_path = public
as $$
declare
  v_user uuid;
  v_used timestamptz;
  v_exp  timestamptz;
begin
  update public.lastfm_auth_states s
     set used_at = now()
   where s.nonce = p_nonce and s.used_at is null and s.expires_at > now()
  returning s.user_id into v_user;
  if found then
    return query select v_user, 'ok'::text;
    return;
  end if;

  select s.used_at, s.expires_at into v_used, v_exp
    from public.lastfm_auth_states s where s.nonce = p_nonce;
  if not found or v_used is not null then
    return query select null::uuid, 'bad_state'::text;
  else
    return query select null::uuid, 'expired_state'::text;
  end if;
end;
$$;

-- Link a PROVEN Last.fm account to a Milk user. Returns 'ok' or 'already_linked'.
--
-- Never moves an account between users. Serialised per Last.fm name (case-
-- insensitive: Last.fm usernames are), and the unique (provider, external_id)
-- constraint is the backstop for any race the lock does not cover.
create or replace function public.lastfm_link_account(p_user uuid, p_name text, p_session_key text)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_id    uuid;
  v_owner uuid;
begin
  perform pg_advisory_xact_lock(hashtext('lastfm_link:' || lower(p_name)));

  select la.id, la.user_id into v_id, v_owner
    from public.linked_accounts la
   where la.provider = 'lastfm' and lower(la.external_id) = lower(p_name);

  if found and v_owner <> p_user then
    return 'already_linked';
  end if;

  if not found then
    -- The user already owns a DIFFERENT Last.fm account. Swapping it would mix
    -- two accounts' histories in one ledger, and unlinking is not built yet.
    if exists (select 1 from public.linked_accounts la
                where la.provider = 'lastfm' and la.user_id = p_user) then
      return 'already_linked';
    end if;
    insert into public.linked_accounts (user_id, provider, external_id, verified_at)
    values (p_user, 'lastfm', p_name, now())
    returning id into v_id;
  else
    update public.linked_accounts
       set verified_at = now(), external_id = p_name
     where id = v_id;
  end if;

  insert into public.linked_account_secrets (linked_account_id, session_key, updated_at)
  values (v_id, p_session_key, now())
  on conflict (linked_account_id)
    do update set session_key = excluded.session_key, updated_at = now();

  return 'ok';
exception
  when unique_violation then
    return 'already_linked';
end;
$$;

-- ------------------------------------------------------------------ sync --

-- Start (or resume) a sync and take the per-account lease.
--
-- Returns the window to walk. `busy` when another call holds the lease.
-- `idle_recent` when the last sync finished less than p_min_interval_s ago and
-- nothing is in progress (the caller then reports done without fetching).
create or replace function public.lastfm_begin_sync(
  p_account uuid,
  p_user uuid,
  p_lookback_s bigint,
  p_lease_s integer,
  p_min_interval_s integer
)
returns table (status text, sync_from bigint, sync_to bigint, walk_to bigint, walk_page integer)
language plpgsql
set search_path = public
as $$
declare
  st      public.lastfm_sync_state%rowtype;
  v_now   bigint := floor(extract(epoch from now()))::bigint;
  v_last  timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('lastfm_sync:' || p_account::text));

  insert into public.lastfm_sync_state (linked_account_id, user_id)
  values (p_account, p_user)
  on conflict (linked_account_id) do nothing;

  select * into st from public.lastfm_sync_state s where s.linked_account_id = p_account;

  if st.lease_until is not null and st.lease_until > now() then
    return query select 'busy'::text, st.sync_from, st.sync_to, st.walk_to, st.walk_page;
    return;
  end if;

  if st.sync_to is null then
    select la.last_synced_at into v_last from public.linked_accounts la where la.id = p_account;
    if st.cursor_ts is not null and v_last is not null
       and v_last > now() - make_interval(secs => p_min_interval_s) then
      return query select 'idle_recent'::text, null::bigint, null::bigint, null::bigint, null::integer;
      return;
    end if;
    -- Pin the window. `to` is fixed for the whole sync, so scrobbles arriving
    -- mid-walk cannot shift it; they are picked up by the next sync.
    update public.lastfm_sync_state s
       set sync_from = case when st.cursor_ts is null then null
                            else greatest(st.cursor_ts - p_lookback_s, 1) end,
           sync_to   = v_now,
           walk_to   = v_now,
           walk_page = 1
     where s.linked_account_id = p_account
    returning * into st;
  end if;

  update public.lastfm_sync_state s
     set lease_until = now() + make_interval(secs => p_lease_s), updated_at = now()
   where s.linked_account_id = p_account;

  return query select 'ok'::text, st.sync_from, st.sync_to, st.walk_to, st.walk_page;
end;
$$;

create or replace function public.lastfm_release_sync(p_account uuid)
returns void
language sql
set search_path = public
as $$
  update public.lastfm_sync_state set lease_until = null where linked_account_id = p_account;
$$;

-- Ingest one page of scrobbles and advance the walk, in ONE transaction, so the
-- ledger and the walk position can never disagree.
--
-- Compare-and-set on (walk_to, walk_page): if another call already advanced the
-- walk, nothing is written and applied = false. Re-ingesting would be harmless
-- (the ledger ignores duplicates), but advancing from a stale position is not.
--
-- p_plays: [{ "uts": int, "artist": text, "track": text, "key": text, "mbid": text|null }]
create or replace function public.lastfm_ingest_page(
  p_account uuid,
  p_user uuid,
  p_expect_to bigint,
  p_expect_page integer,
  p_plays jsonb,
  p_next_to bigint,
  p_next_page integer,
  p_done boolean
)
returns table (applied boolean, inserted integer)
language plpgsql
set search_path = public
as $$
declare
  st  public.lastfm_sync_state%rowtype;
  n   integer;
begin
  perform pg_advisory_xact_lock(hashtext('lastfm_sync:' || p_account::text));

  select * into st from public.lastfm_sync_state s
   where s.linked_account_id = p_account and s.user_id = p_user;
  if not found or st.sync_to is null
     or st.walk_to is distinct from p_expect_to
     or st.walk_page is distinct from p_expect_page then
    return query select false, 0;
    return;
  end if;

  insert into public.lastfm_scrobbles (user_id, uts, fp, artist_name, artist_key, artist_mbid)
  select p_user,
         (e ->> 'uts')::bigint,
         md5((e ->> 'artist') || E'\n' || (e ->> 'track'))::uuid,
         e ->> 'artist',
         e ->> 'key',
         nullif(lower(btrim(coalesce(e ->> 'mbid', ''))), '')
    from jsonb_array_elements(p_plays) e
  on conflict do nothing;
  get diagnostics n = row_count;

  if p_done then
    update public.lastfm_sync_state s
       set cursor_ts = st.sync_to, sync_from = null, sync_to = null,
           walk_to = null, walk_page = null, updated_at = now()
     where s.linked_account_id = p_account;
    update public.linked_accounts la
       set cursor_ts = st.sync_to, last_synced_at = now()
     where la.id = p_account;
  else
    update public.lastfm_sync_state s
       set walk_to = p_next_to, walk_page = p_next_page, updated_at = now()
     where s.linked_account_id = p_account;
  end if;

  return query select true, n;
end;
$$;

-- Re-derive one user's artist_plays from their ledger.
--
-- Artist resolution, in order (docs/REWARDS.md section 9):
--   1. a scrobble WITH an MBID counts for that MBID;
--   2. a scrobble WITHOUT one counts for the single MBID whose artistKey equals
--      the scrobble's, drawing candidates from the catalog (artists with a real
--      MBID, via artist_name_keys) and from this user's own MBID-bearing
--      scrobbles;
--   3. otherwise -- no candidate, or two or more (ambiguous) -- it counts for
--      the synthetic artist 'name:<artistKey>'.
--
-- Because this is a pure function of the ledger and the catalog, consolidation
-- is automatic: when an MBID for a name first becomes known, the next
-- recompute moves those plays onto it and drops the 'name:' row. Every ledger
-- row lands in exactly one artist, so no play is counted twice or lost.
--
-- Returns the number of distinct artists the user has plays for.
create or replace function public.lastfm_recompute_artist_plays(p_user uuid)
returns integer
language plpgsql
set search_path = public
as $$
declare
  n integer;
begin
  perform pg_advisory_xact_lock(hashtext('artist_plays:' || p_user::text));

  -- Dropped first: a second call in the same transaction must not collide.
  drop table if exists pg_temp._lf_counts;
  create temp table _lf_counts (key text primary key, name text not null, plays integer not null)
    on commit drop;

  insert into _lf_counts (key, name, plays)
  with cand as (
    select s.artist_key as k, s.artist_mbid as m
      from public.lastfm_scrobbles s
     where s.user_id = p_user and s.artist_mbid is not null
    union
    select nk.name_key, a.mbid
      from public.artist_name_keys nk
      join public.artists a on a.id = nk.artist_id
     where a.mbid not like 'name:%'
  ),
  uniq as (
    select k, min(m) as m from cand group by k having count(distinct m) = 1
  ),
  resolved as (
    select coalesce(s.artist_mbid, u.m, 'name:' || s.artist_key) as key, s.artist_name
      from public.lastfm_scrobbles s
      left join uniq u on s.artist_mbid is null and u.k = s.artist_key
     where s.user_id = p_user
  )
  select key, mode() within group (order by artist_name), count(*)::integer
    from resolved
   group by key;

  -- Artists nobody has seen yet. Existing rows keep their (catalog) name.
  insert into public.artists (mbid, name)
  select c.key, c.name from _lf_counts c
  on conflict (mbid) do nothing;

  insert into public.artist_plays (user_id, artist_id, plays, updated_at)
  select p_user, a.id, c.plays, now()
    from _lf_counts c join public.artists a on a.mbid = c.key
  on conflict (user_id, artist_id) do update
    set plays = excluded.plays, updated_at = now()
    where public.artist_plays.plays is distinct from excluded.plays;

  -- Rows that are no longer a resolution target (e.g. 'name:2pac' after its
  -- plays consolidated onto the MBID).
  delete from public.artist_plays ap
   where ap.user_id = p_user
     and not exists (select 1 from _lf_counts c join public.artists a on a.mbid = c.key
                      where a.id = ap.artist_id);

  select count(*) into n from _lf_counts;
  return n;
end;
$$;

-- --------------------------------------------------------- permissions --

revoke all on function public.lastfm_consume_state(text) from public, anon, authenticated;
revoke all on function public.lastfm_link_account(uuid, text, text) from public, anon, authenticated;
revoke all on function public.lastfm_begin_sync(uuid, uuid, bigint, integer, integer) from public, anon, authenticated;
revoke all on function public.lastfm_release_sync(uuid) from public, anon, authenticated;
revoke all on function public.lastfm_ingest_page(uuid, uuid, bigint, integer, jsonb, bigint, integer, boolean) from public, anon, authenticated;
revoke all on function public.lastfm_recompute_artist_plays(uuid) from public, anon, authenticated;

grant execute on function public.lastfm_consume_state(text) to service_role;
grant execute on function public.lastfm_link_account(uuid, text, text) to service_role;
grant execute on function public.lastfm_begin_sync(uuid, uuid, bigint, integer, integer) to service_role;
grant execute on function public.lastfm_release_sync(uuid) to service_role;
grant execute on function public.lastfm_ingest_page(uuid, uuid, bigint, integer, jsonb, bigint, integer, boolean) to service_role;
grant execute on function public.lastfm_recompute_artist_plays(uuid) to service_role;
