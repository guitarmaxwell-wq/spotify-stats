-- Fix a name collision introduced by 20260919040100: the grouped CTE's column
-- `n` shadowed the PL/pgSQL variable `n`, so the function raised
-- "column reference n is ambiguous" at runtime. Renamed to `cnt`. No behaviour
-- change beyond it now running.

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
  with grouped as (
    -- The ledger folded onto what resolution actually depends on: ~4k groups
    -- instead of ~140k rows.
    select s.artist_key as k, s.artist_mbid as m, count(*)::integer as cnt,
           min(s.artist_name) as nm
      from public.lastfm_scrobbles s
     where s.user_id = p_user
     group by s.artist_key, s.artist_mbid
  ),
  cand as (
    -- Known MBIDs for a normalized name: this user's own scrobbles, plus the
    -- catalog (artists with a real MBID, keyed by artist_name_keys).
    select g.k, g.m from grouped g where g.m is not null
    union
    select nk.name_key, a.mbid
      from public.artist_name_keys nk
      join public.artists a on a.id = nk.artist_id
     where a.mbid not like 'name:%'
  ),
  uniq as (
    -- Exactly one MBID for the name. Two or more is ambiguous: never guessed.
    select k, min(m) as m from cand group by k having count(distinct m) = 1
  ),
  resolved as (
    select coalesce(g.m, u.m, 'name:' || g.k) as key, g.nm, g.cnt
      from grouped g
      left join uniq u on g.m is null and u.k = g.k
  )
  select key, (array_agg(nm order by cnt desc))[1], sum(cnt)::integer
    from resolved
   group by key;

  insert into public.artists (mbid, name)
  select c.key, c.name from _lf_counts c
  on conflict (mbid) do nothing;

  insert into public.artist_plays (user_id, artist_id, plays, updated_at)
  select p_user, a.id, c.plays, now()
    from _lf_counts c join public.artists a on a.mbid = c.key
  on conflict (user_id, artist_id) do update
    set plays = excluded.plays, updated_at = now()
    where public.artist_plays.plays is distinct from excluded.plays;

  delete from public.artist_plays ap
   where ap.user_id = p_user
     and not exists (select 1 from _lf_counts c join public.artists a on a.mbid = c.key
                      where a.id = ap.artist_id);

  select count(*) into n from _lf_counts;
  return n;
end;
$$;

revoke all on function public.lastfm_recompute_artist_plays(uuid) from public, anon, authenticated;
grant execute on function public.lastfm_recompute_artist_plays(uuid) to service_role;
