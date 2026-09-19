-- SQL tests for supabase/migrations/20260919040000_lastfm_sync.sql.
--
-- Run inside a transaction that is ROLLED BACK, so nothing persists (the test
-- users are inserted straight into auth.users, which sends no email, and never
-- committed):
--
--   ( echo 'begin;'; cat supabase/functions/_shared/lastfm/sql_tests.sql; echo 'rollback;' ) > t.sql
--   ./node_modules/.bin/supabase db query --linked -f t.sql
--
-- Every check raises on failure; success prints one row: {"result": "all passed"}.

do $$
declare
  ua uuid := gen_random_uuid();
  ub uuid := gen_random_uuid();
  r record;
  s text;
  acc uuid;
  n integer;
  total integer;
  mb_2pac text := '382f1005-e9ab-4684-afd4-0bdae4ee37f2';
  mb_n1 text := '5b11f4ce-a62d-471e-81fc-a69a8278c7da';
  mb_n2 text := 'aaaaaaaa-0000-0000-0000-000000000002';
  mb_blink text := '0743b15a-3c32-48c8-ad58-cb325350befa';
  mb_foo text := 'ffffffff-0000-0000-0000-00000000000f';
  art uuid;
begin
  insert into auth.users (id, aud, role) values (ua, 'authenticated', 'authenticated'), (ub, 'authenticated', 'authenticated');

  -- ---------------------------------------------------------- nonces --
  insert into public.lastfm_auth_states (nonce, user_id) values (repeat('a', 43), ua);
  insert into public.lastfm_auth_states (nonce, user_id, created_at, expires_at)
    values (repeat('e', 43), ua, now() - interval '11 minutes', now() - interval '1 minute');

  select * into r from public.lastfm_consume_state(repeat('a', 43));
  if r.status <> 'ok' or r.user_id <> ua then raise exception 'nonce: first use should be ok, got %', r; end if;
  select * into r from public.lastfm_consume_state(repeat('a', 43));
  if r.status <> 'bad_state' or r.user_id is not null then raise exception 'nonce: reuse should be bad_state, got %', r; end if;
  select * into r from public.lastfm_consume_state(repeat('z', 43));
  if r.status <> 'bad_state' then raise exception 'nonce: unknown should be bad_state, got %', r; end if;
  select * into r from public.lastfm_consume_state(repeat('e', 43));
  if r.status <> 'expired_state' then raise exception 'nonce: expired should be expired_state, got %', r; end if;
  -- An expired nonce must not have been marked used either.
  if (select used_at from public.lastfm_auth_states where nonce = repeat('e', 43)) is not null then
    raise exception 'nonce: expired nonce was consumed';
  end if;

  -- ---------------------------------------------------------- linking --
  s := public.lastfm_link_account(ua, 'SomeUser', 'sk-1');
  if s <> 'ok' then raise exception 'link: first link should be ok, got %', s; end if;
  s := public.lastfm_link_account(ub, 'someuser', 'sk-2');
  if s <> 'already_linked' then raise exception 'link: other user (case-folded) should be already_linked, got %', s; end if;
  s := public.lastfm_link_account(ub, 'SomeUser', 'sk-2');
  if s <> 'already_linked' then raise exception 'link: other user should be already_linked, got %', s; end if;
  if (select user_id from public.linked_accounts where provider = 'lastfm' and external_id = 'SomeUser') <> ua then
    raise exception 'link: account moved between users';
  end if;
  s := public.lastfm_link_account(ua, 'SomeUser', 'sk-3');
  if s <> 'ok' then raise exception 'link: relink by owner should be ok, got %', s; end if;
  s := public.lastfm_link_account(ua, 'OtherAccount', 'sk-4');
  if s <> 'already_linked' then raise exception 'link: second account for same user should be refused, got %', s; end if;
  select la.id into acc from public.linked_accounts la where la.user_id = ua and la.provider = 'lastfm';
  if (select verified_at from public.linked_accounts where id = acc) is null then raise exception 'link: verified_at not set'; end if;
  if (select session_key from public.linked_account_secrets where linked_account_id = acc) <> 'sk-3' then
    raise exception 'link: session key not stored/updated';
  end if;
  if (select count(*) from public.linked_accounts where user_id = ub) <> 0 then raise exception 'link: user b got a row'; end if;

  -- ------------------------------------------------------ sync walk --
  select * into r from public.lastfm_begin_sync(acc, ua, 1209600, 90, 60);
  if r.status <> 'ok' or r.sync_from is not null or r.walk_to <> r.sync_to or r.walk_page <> 1 then
    raise exception 'sync: first begin wrong: %', r;
  end if;
  select * into r from public.lastfm_begin_sync(acc, ua, 1209600, 90, 60);
  if r.status <> 'busy' then raise exception 'sync: concurrent begin should be busy, got %', r; end if;
  perform public.lastfm_release_sync(acc);
  select * into r from public.lastfm_begin_sync(acc, ua, 1209600, 90, 60);
  if r.status <> 'ok' then raise exception 'sync: resume after release should be ok, got %', r; end if;

  -- Stale compare-and-set: nothing written.
  select * into r from public.lastfm_ingest_page(acc, ua, r.walk_to + 5, 1,
    '[{"uts":100,"artist":"X","track":"t","key":"x","mbid":null}]'::jsonb, 50, 1, false);
  if r.applied or r.inserted <> 0 then raise exception 'sync: stale CAS applied: %', r; end if;
  if exists (select 1 from public.lastfm_scrobbles where user_id = ua) then raise exception 'sync: stale CAS wrote plays'; end if;

  select walk_to into n from public.lastfm_sync_state where linked_account_id = acc;
  -- Page 1: 2pac x3 with MBID, 2 without; a same-second tie; one exact duplicate in the payload.
  select * into r from public.lastfm_ingest_page(acc, ua, n, 1, jsonb_build_array(
    jsonb_build_object('uts', 1000, 'artist', '2Pac', 'track', 'a', 'key', '2pac', 'mbid', upper(mb_2pac)),
    jsonb_build_object('uts', 999,  'artist', '2Pac', 'track', 'b', 'key', '2pac', 'mbid', mb_2pac),
    jsonb_build_object('uts', 998,  'artist', '2Pac', 'track', 'c', 'key', '2pac', 'mbid', mb_2pac),
    jsonb_build_object('uts', 997,  'artist', '2Pac', 'track', 'd', 'key', '2pac', 'mbid', null),
    jsonb_build_object('uts', 996,  'artist', '2pac', 'track', 'e', 'key', '2pac', 'mbid', ''),
    jsonb_build_object('uts', 996,  'artist', '2pac', 'track', 'e2', 'key', '2pac', 'mbid', ''),
    jsonb_build_object('uts', 996,  'artist', '2pac', 'track', 'e2', 'key', '2pac', 'mbid', '')
  ), 997, 1, false);
  if not r.applied or r.inserted <> 6 then raise exception 'sync: page 1 should insert 6 (one in-payload dup), got %', r; end if;
  -- Page 2 re-reads the boundary second (996) plus new rows. Only the new ones count.
  select * into r from public.lastfm_ingest_page(acc, ua, 997, 1, jsonb_build_array(
    jsonb_build_object('uts', 996, 'artist', '2pac', 'track', 'e', 'key', '2pac', 'mbid', ''),
    jsonb_build_object('uts', 996, 'artist', '2pac', 'track', 'e2', 'key', '2pac', 'mbid', ''),
    jsonb_build_object('uts', 990, 'artist', 'Nirvana', 'track', 'n1', 'key', 'nirvana', 'mbid', mb_n1),
    jsonb_build_object('uts', 989, 'artist', 'Nirvana', 'track', 'n2', 'key', 'nirvana', 'mbid', mb_n2),
    jsonb_build_object('uts', 988, 'artist', 'Nirvana', 'track', 'n3', 'key', 'nirvana', 'mbid', null),
    jsonb_build_object('uts', 987, 'artist', 'blink-182', 'track', 'b', 'key', 'blink 182', 'mbid', null),
    jsonb_build_object('uts', 986, 'artist', 'Foo', 'track', 'f1', 'key', 'foo', 'mbid', null),
    jsonb_build_object('uts', 985, 'artist', 'Foo', 'track', 'f2', 'key', 'foo', 'mbid', null)
  ), null, null, true);
  if not r.applied or r.inserted <> 6 then raise exception 'sync: page 2 should insert 6 (boundary re-read deduped), got %', r; end if;
  if (select cursor_ts from public.lastfm_sync_state where linked_account_id = acc) is null
     or (select sync_to from public.lastfm_sync_state where linked_account_id = acc) is not null
     or (select last_synced_at from public.linked_accounts where id = acc) is null then
    raise exception 'sync: done did not commit the cursor';
  end if;
  -- Idle within the min interval (lease still held from this call, so release first).
  perform public.lastfm_release_sync(acc);
  select * into r from public.lastfm_begin_sync(acc, ua, 1209600, 90, 60);
  if r.status <> 'idle_recent' then raise exception 'sync: immediate re-sync should be idle_recent, got %', r; end if;
  -- With no min interval, the next window starts cursor - lookback.
  select * into r from public.lastfm_begin_sync(acc, ua, 1209600, 90, 0);
  if r.status <> 'ok' or r.sync_from <> greatest((select cursor_ts from public.lastfm_sync_state where linked_account_id = acc) - 1209600, 1) then
    raise exception 'sync: incremental window wrong: %', r;
  end if;

  -- ---------------------------------------------------- resolution --
  -- Catalog: blink-182 seeded with its real MBID (name key computed by the TS normalizer).
  insert into public.artists (mbid, name) values (mb_blink, 'blink-182') on conflict (mbid) do nothing;
  insert into public.artist_name_keys (artist_id, name_key)
    select id, 'blink 182' from public.artists where mbid = mb_blink on conflict do nothing;

  n := public.lastfm_recompute_artist_plays(ua);

  -- 2pac: 3 with MBID + 3 without (d, e, e2) -> all 6 on the MBID; no name:2pac row.
  select ap.plays into n from public.artist_plays ap join public.artists a on a.id = ap.artist_id
   where ap.user_id = ua and a.mbid = mb_2pac;
  if n is distinct from 6 then raise exception 'resolve: 2pac should be 6 on the MBID, got %', n; end if;
  if exists (select 1 from public.artist_plays ap join public.artists a on a.id = ap.artist_id
              where ap.user_id = ua and a.mbid = 'name:2pac') then
    raise exception 'resolve: name:2pac should not exist';
  end if;
  -- blink-182: no MBID on the scrobble, resolves by name to the seeded MBID.
  select ap.plays into n from public.artist_plays ap join public.artists a on a.id = ap.artist_id
   where ap.user_id = ua and a.mbid = mb_blink;
  if n is distinct from 1 then raise exception 'resolve: blink-182 should resolve to the seeded MBID, got %', n; end if;
  -- Nirvana: two MBIDs share the key -> the MBID-less play stays synthetic.
  select ap.plays into n from public.artist_plays ap join public.artists a on a.id = ap.artist_id
   where ap.user_id = ua and a.mbid = 'name:nirvana';
  if n is distinct from 1 then raise exception 'resolve: ambiguous nirvana should stay name:nirvana=1, got %', n; end if;
  if (select ap.plays from public.artist_plays ap join public.artists a on a.id = ap.artist_id
       where ap.user_id = ua and a.mbid = mb_n1) <> 1 then raise exception 'resolve: nirvana n1 wrong'; end if;
  -- Foo: unknown -> synthetic.
  select ap.plays into n from public.artist_plays ap join public.artists a on a.id = ap.artist_id
   where ap.user_id = ua and a.mbid = 'name:foo';
  if n is distinct from 2 then raise exception 'resolve: foo should be name:foo=2, got %', n; end if;

  -- Consolidation: an MBID for "foo" becomes known later.
  insert into public.artists (mbid, name) values (mb_foo, 'Foo') returning id into art;
  insert into public.artist_name_keys (artist_id, name_key) values (art, 'foo');
  perform public.lastfm_recompute_artist_plays(ua);
  select ap.plays into n from public.artist_plays ap where ap.user_id = ua and ap.artist_id = art;
  if n is distinct from 2 then raise exception 'consolidate: foo should move to the MBID with 2, got %', n; end if;
  if exists (select 1 from public.artist_plays ap join public.artists a on a.id = ap.artist_id
              where ap.user_id = ua and a.mbid = 'name:foo') then
    raise exception 'consolidate: name:foo row should be gone';
  end if;

  -- Partition invariant: every ledger row is in exactly one artist total.
  select coalesce(sum(plays), 0) into total from public.artist_plays where user_id = ua;
  select count(*) into n from public.lastfm_scrobbles where user_id = ua;
  if total <> n or n <> 12 then raise exception 'invariant: sum(artist_plays)=% ledger=% (want 12)', total, n; end if;

  -- Idempotent: recompute twice changes nothing.
  perform public.lastfm_recompute_artist_plays(ua);
  select coalesce(sum(plays), 0) into total from public.artist_plays where user_id = ua;
  if total <> 12 then raise exception 'idempotence: total changed to %', total; end if;

  -- ------------------------------------------------- client lockout --
  if has_function_privilege('anon', 'public.lastfm_consume_state(text)', 'execute')
     or has_function_privilege('authenticated', 'public.lastfm_link_account(uuid, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.lastfm_ingest_page(uuid, uuid, bigint, integer, jsonb, bigint, integer, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.lastfm_recompute_artist_plays(uuid)', 'execute')
     or has_function_privilege('anon', 'public.lastfm_begin_sync(uuid, uuid, bigint, integer, integer)', 'execute') then
    raise exception 'permissions: a client role can execute a server-only function';
  end if;
  if not has_function_privilege('service_role', 'public.lastfm_ingest_page(uuid, uuid, bigint, integer, jsonb, bigint, integer, boolean)', 'execute') then
    raise exception 'permissions: service_role cannot execute ingest';
  end if;
end;
$$;

select 'all passed' as result;
