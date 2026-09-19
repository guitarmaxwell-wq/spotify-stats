-- Reject malformed rules at the database, not just in the dry run.
--
-- Admins write `rules` directly (RLS policy rules_admin_write), so without this
-- a dashboard bug or a hand-edited row could save a rule the evaluator cannot
-- run -- and the evaluator would then skip it silently for every user. The
-- checks and messages mirror supabase/functions/_shared/rules/validate.ts
-- (parseParams + checkReward); keep the two in sync. The message reaches the
-- dashboard as the PostgREST error `message`, so it is written for a human.

create or replace function public.rules_validate()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  mbid_re   constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  allowed   text[];
  extra     text[];
  subj      text;          -- the rule type's subject kind: 'artist', 'album' or null
  target    text;          -- params.artist / params.album
  wildcard  boolean := false;
  thr       jsonb;
  rw        public.rewards%rowtype;
  template  boolean;
begin
  allowed := case new.type
    when 'artist_plays'           then array['artist', 'threshold']
    when 'album_unlocked'         then array['album']
    when 'album_passes'           then array['album', 'threshold']
    when 'artist_albums_unlocked' then array['artist', 'threshold']
    when 'albums_unlocked'        then array['threshold']
  end;
  if allowed is null then
    raise exception 'Unknown rule type "%". Expected one of: artist_plays, album_unlocked, album_passes, artist_albums_unlocked, albums_unlocked.', new.type
      using errcode = '22023';
  end if;

  select array_agg(k order by k) into extra
    from jsonb_object_keys(new.params) as k
   where k <> all (allowed);
  if extra is not null then
    raise exception '% does not take %. It takes: %.%',
      new.type,
      (select string_agg('params.' || e, ', ') from unnest(extra) e),
      array_to_string(allowed, ', '),
      case when new.type = 'album_unlocked' and 'threshold' = any (extra)
           then ' album_unlocked has no threshold (it means one full pass); use album_passes for "N passes".'
           else '' end
      using errcode = '22023';
  end if;

  subj := case when new.type in ('artist_plays', 'artist_albums_unlocked') then 'artist'
               when new.type in ('album_unlocked', 'album_passes') then 'album' end;

  if subj is not null then
    if not new.params ? subj then
      raise exception 'params.% is required.', subj using errcode = '22023';
    end if;
    if jsonb_typeof(new.params -> subj) <> 'string' then
      raise exception 'params.% must be a string.', subj using errcode = '22023';
    end if;
    target := new.params ->> subj;
    wildcard := target = '*';
    if not (wildcard
            or target ~ mbid_re
            or (subj = 'artist' and target like 'name:_%' and target = btrim(target))) then
      if lower(target) ~ mbid_re then
        raise exception 'params.% "%" must be lowercase, as MusicBrainz ids are stored.', subj, target
          using errcode = '22023';
      end if;
      raise exception 'params.% "%" is not %.', subj, target,
        case subj when 'artist' then 'an artist MBID, a "name:<artistKey>" key, or "*"'
                  else 'a release MBID or "*"' end
        using errcode = '22023';
    end if;
  end if;

  if 'threshold' = any (allowed) then
    thr := new.params -> 'threshold';
    if thr is null then
      raise exception 'params.threshold is required: a whole number of at least 1.' using errcode = '22023';
    end if;
    if jsonb_typeof(thr) <> 'number' or (thr::text)::numeric <> trunc((thr::text)::numeric) then
      raise exception 'params.threshold must be a whole number, not %.', thr::text using errcode = '22023';
    end if;
    if (thr::text)::numeric < 1 then
      raise exception 'params.threshold must be at least 1, not %.', thr::text using errcode = '22023';
    end if;
    if (thr::text)::numeric > 1000000 then
      raise exception 'params.threshold must be at most 1000000, not %.', thr::text using errcode = '22023';
    end if;
  end if;

  -- The reward must be grantable by this rule (validate.ts checkReward).
  select * into rw from public.rewards where id = new.reward_id;
  if found then
    template := rw.subject_kind is not null and rw.artist_id is null and rw.album_id is null;
    if wildcard and not (template and rw.subject_kind = subj) then
      raise exception 'A wildcard % rule grants one reward per %, so its reward must be a per-% template (subject_kind "%" with no specific artist or album). This reward is not.',
        new.type, subj, subj, subj using errcode = '22023';
    end if;
    if not wildcard and template and rw.subject_kind is distinct from subj then
      if subj is null then
        raise exception '% has no artist or album subject, so it cannot grant a per-% template reward. Pick a reward with no subject kind.',
          new.type, rw.subject_kind using errcode = '22023';
      end if;
      raise exception 'This reward is a per-% template, but % rules are about an %.',
        rw.subject_kind, new.type, subj using errcode = '22023';
    end if;
  end if;
  -- (A missing reward is already rejected by the foreign key.)

  return new;
end;
$$;

create trigger rules_validate
  before insert or update of type, params, reward_id on public.rules
  for each row execute function public.rules_validate();
