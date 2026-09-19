-- Starter rewards and rules, so the system does something visible on the
-- owner's real history the moment their plays first sync.
--
-- Art: placeholders from tools/stickers/generate.py (manifest.json lists every
-- file), uploaded to the public `reward-art` bucket by tools/stickers/upload.sh.
-- Replacing a placeholder with real art is an upload to the same path; no row
-- changes.
--
-- Artist ids are real MusicBrainz MBIDs, looked up on musicbrainz.org on
-- 2026-09-19 (score 100, single match). There is one exception, The Jackson 5,
-- explained next to its row.
--
-- `artists.name` is the JOIN KEY for scrobbles that arrive without an MBID:
-- the sync matches artistKey(scrobbled name) against artistKey(artists.name).
-- So each name below is spelled the way Last.fm writes the artist, even where
-- MusicBrainz differs (MusicBrainz writes "blink‐182" with U+2010; Last.fm
-- writes "blink-182"). Both normalize to "blink 182", and ASCII is used anyway.
--
-- Rows use fixed ids and ON CONFLICT DO NOTHING, so re-running is harmless and
-- the admin dashboard can later edit these rows like any others.
--
-- Expected grants on the owner's FIRST sync, from data/plays.csv (138,551
-- scrobbles, 2020-04 .. 2026-09). A range is given where the answer depends on
-- whether MBID-less scrobbles merge into the MBID'd artist:
--   artist_plays *  25 -> artist sticker     618-673 artists   (flagged: a lot)
--   artist_plays * 100 -> community pass     223-227 artists
--   album_passes *   5 -> poster             ~50 albums, but only once the
--                                             album catalog lands (milestone 1b)
--   band numbers                             6 of 9 (list in the rule notes)

-- ------------------------------------------------------------------ artists --

insert into public.artists (mbid, name) values
  ('0743b15a-3c32-48c8-ad58-cb325350befa', 'blink-182'),
  ('f2eef649-a6d5-4114-afba-e50ab26254d2', 'Sum 41'),
  ('8e68819d-71be-4e7d-b41d-f1df81b01d3f', '50 Cent'),
  ('37b2cb82-ef79-4d46-a184-a549450aa231', '21 Savage'),
  ('4822d466-5c1f-4e04-80e9-e33e8295c26b', '702'),
  ('48513f24-37d5-423f-b9b7-2b712af7f50d', '9th Wonder'),
  ('0ab49580-c84f-44d4-875f-d83760ea2cfe', 'Maroon 5'),
  ('c23b637b-97c6-41eb-8ef6-6c724efc80a8', 'Zero 7'),
  -- The Jackson 5 has NO MBID of its own: MusicBrainz folds the group into
  -- "The Jacksons" (e5257dc5-1edd-4fca-b7e6-1158e00522c8), and Last.fm sends
  -- every "The Jackson 5" scrobble with an empty artist MBID. So the sync keys
  -- those plays as name:<artistKey> = name:jackson 5, and this row uses that key.
  -- Using The Jacksons' MBID would also count the post-1975 group under a
  -- sticker about the number 5.
  ('name:jackson 5', 'The Jackson 5')
on conflict (mbid) do nothing;

-- ------------------------------------------------------------------ rewards --

-- Per-subject TEMPLATES (subject_kind set, no artist/album). A wildcard rule
-- grants one of these per artist or album. art_url is the generic template art;
-- per-subject art is resolved from the grant's subject.
insert into public.rewards (id, kind, name, description, art_url, subject_kind) values
  ('5eed0000-0000-4000-8000-000000000001', 'sticker', 'Artist sticker',
   'A sticker for an artist you keep coming back to.',
   'https://ygtfmwwlsgjljjrkpilb.supabase.co/storage/v1/object/public/reward-art/templates/artist-sticker.svg',
   'artist'),
  ('5eed0000-0000-4000-8000-000000000002', 'community', 'Community pass',
   'Access to the artist''s community, for listeners who have put the hours in.',
   'https://ygtfmwwlsgjljjrkpilb.supabase.co/storage/v1/object/public/reward-art/templates/community-pass.svg',
   'artist'),
  ('5eed0000-0000-4000-8000-000000000003', 'poster', 'Album poster',
   'A poster for an album you have played front to back, again and again.',
   'https://ygtfmwwlsgjljjrkpilb.supabase.co/storage/v1/object/public/reward-art/templates/poster.svg',
   'album')
on conflict (id) do nothing;

-- Band-number stickers: one specific reward per artist, the number as the hero.
insert into public.rewards (id, kind, name, description, art_url, subject_kind, artist_id)
select v.id::uuid, 'sticker', v.name, v.description,
       'https://ygtfmwwlsgjljjrkpilb.supabase.co/storage/v1/object/public/reward-art/' || v.path,
       'artist', a.id
from (values
  ('5eed0000-0000-4000-8000-000000000101', '0743b15a-3c32-48c8-ad58-cb325350befa', 'blink-182 · 182',
   '182 plays of blink-182.', 'number/blink-182.svg'),
  ('5eed0000-0000-4000-8000-000000000102', 'f2eef649-a6d5-4114-afba-e50ab26254d2', 'Sum 41 · 41',
   '41 plays of Sum 41.', 'number/sum-41.svg'),
  ('5eed0000-0000-4000-8000-000000000103', '8e68819d-71be-4e7d-b41d-f1df81b01d3f', '50 Cent · 50',
   '50 plays of 50 Cent.', 'number/50-cent.svg'),
  ('5eed0000-0000-4000-8000-000000000104', '37b2cb82-ef79-4d46-a184-a549450aa231', '21 Savage · 21',
   '21 plays of 21 Savage.', 'number/21-savage.svg'),
  ('5eed0000-0000-4000-8000-000000000105', '4822d466-5c1f-4e04-80e9-e33e8295c26b', '702 · 702',
   '702 plays of 702.', 'number/702.svg'),
  ('5eed0000-0000-4000-8000-000000000106', '48513f24-37d5-423f-b9b7-2b712af7f50d', '9th Wonder · 9',
   '9 plays of 9th Wonder.', 'number/9th-wonder.svg'),
  ('5eed0000-0000-4000-8000-000000000107', 'name:jackson 5', 'The Jackson 5 · 5',
   '5 plays of The Jackson 5.', 'number/the-jackson-5.svg'),
  ('5eed0000-0000-4000-8000-000000000108', '0ab49580-c84f-44d4-875f-d83760ea2cfe', 'Maroon 5 · 5',
   '5 plays of Maroon 5.', 'number/maroon-5.svg'),
  ('5eed0000-0000-4000-8000-000000000109', 'c23b637b-97c6-41eb-8ef6-6c724efc80a8', 'Zero 7 · 7',
   '7 plays of Zero 7.', 'number/zero-7.svg')
) as v(id, mbid, name, description, path)
join public.artists a on a.mbid = v.mbid
on conflict (id) do nothing;

-- -------------------------------------------------------------------- rules --
-- params hold ONLY what the rule type takes (the rules_validate trigger
-- rejects anything else). The reasoning lives in notes.

insert into public.rules (id, type, params, reward_id, active, notes) values
  ('5eed0000-0000-4000-8000-000000001001', 'artist_plays',
   '{"artist": "*", "threshold": 25}', '5eed0000-0000-4000-8000-000000000001', true,
   'Starter: any artist at 25 plays earns that artist''s sticker. On the owner''s history this grants '
   '618-673 stickers on the first sync, likely too many to feel special. 100 plays gives ~225, '
   '250 gives ~104, 500 gives ~57. Tune here; lowering is retroactive, raising keeps existing grants.'),
  ('5eed0000-0000-4000-8000-000000001002', 'artist_plays',
   '{"artist": "*", "threshold": 100}', '5eed0000-0000-4000-8000-000000000002', true,
   'docs/REWARDS.md section 1: any artist at 100 plays unlocks that artist''s community (access, '
   'server-evaluated). Owner''s first sync: 223-227 communities.'),
  ('5eed0000-0000-4000-8000-000000001003', 'album_passes',
   '{"album": "*", "threshold": 5}', '5eed0000-0000-4000-8000-000000000003', true,
   'docs/REWARDS.md section 1: every track of an album played 5+ times earns its poster. Grants '
   'nothing until the album catalog is in Postgres (milestone 1b); then ~50 of the owner''s 816 '
   'shelf albums qualify (246 have 1+ pass, 25 have 10+).')
on conflict (id) do nothing;

insert into public.rules (id, type, params, reward_id, active, notes) values
  ('5eed0000-0000-4000-8000-000000001101', 'artist_plays',
   '{"artist": "0743b15a-3c32-48c8-ad58-cb325350befa", "threshold": 182}',
   '5eed0000-0000-4000-8000-000000000101', true,
   'Band number: blink-182 at 182. Owner has 1 play (not earned). Last.fm sends blink-182 without '
   'an MBID; the sync matches it to this artist by name ("blink 182").'),
  ('5eed0000-0000-4000-8000-000000001102', 'artist_plays',
   '{"artist": "f2eef649-a6d5-4114-afba-e50ab26254d2", "threshold": 41}',
   '5eed0000-0000-4000-8000-000000000102', true,
   'Band number: Sum 41 at 41. Owner has 0 plays (not earned).'),
  ('5eed0000-0000-4000-8000-000000001103', 'artist_plays',
   '{"artist": "8e68819d-71be-4e7d-b41d-f1df81b01d3f", "threshold": 50}',
   '5eed0000-0000-4000-8000-000000000103', true,
   'Band number: 50 Cent at 50. Owner has 77-80 plays (earned on first sync).'),
  ('5eed0000-0000-4000-8000-000000001104', 'artist_plays',
   '{"artist": "37b2cb82-ef79-4d46-a184-a549450aa231", "threshold": 21}',
   '5eed0000-0000-4000-8000-000000000104', true,
   'Band number: 21 Savage at 21. Owner has 74-77 plays (earned on first sync).'),
  ('5eed0000-0000-4000-8000-000000001105', 'artist_plays',
   '{"artist": "4822d466-5c1f-4e04-80e9-e33e8295c26b", "threshold": 702}',
   '5eed0000-0000-4000-8000-000000000105', true,
   'Band number: 702 (the R&B group, named for the Las Vegas area code) at 702. Owner has 92 plays: '
   'a goal to chase, not earned yet.'),
  ('5eed0000-0000-4000-8000-000000001106', 'artist_plays',
   '{"artist": "48513f24-37d5-423f-b9b7-2b712af7f50d", "threshold": 9}',
   '5eed0000-0000-4000-8000-000000000106', true,
   'Band number: 9th Wonder at 9. Owner has 249-271 plays (earned on first sync). A low bar, but '
   'the number is the name.'),
  ('5eed0000-0000-4000-8000-000000001107', 'artist_plays',
   '{"artist": "name:jackson 5", "threshold": 5}',
   '5eed0000-0000-4000-8000-000000000107', true,
   'Band number: The Jackson 5 at 5. Targets the synthetic key name:jackson 5, not an MBID: '
   'MusicBrainz folds the group into "The Jacksons" (e5257dc5-1edd-4fca-b7e6-1158e00522c8) and '
   'Last.fm sends every Jackson 5 scrobble with no MBID, so no MBID row would ever match. '
   'Owner has 59 plays (earned on first sync).'),
  ('5eed0000-0000-4000-8000-000000001108', 'artist_plays',
   '{"artist": "0ab49580-c84f-44d4-875f-d83760ea2cfe", "threshold": 5}',
   '5eed0000-0000-4000-8000-000000000108', true,
   'Band number: Maroon 5 at 5. Owner has 40 plays (earned on first sync).'),
  ('5eed0000-0000-4000-8000-000000001109', 'artist_plays',
   '{"artist": "c23b637b-97c6-41eb-8ef6-6c724efc80a8", "threshold": 7}',
   '5eed0000-0000-4000-8000-000000000109', true,
   'Band number: Zero 7 at 7. Owner has 58 plays (earned on first sync).')
on conflict (id) do nothing;

-- A seed that silently inserted nothing (e.g. a join that matched no artist)
-- must fail loudly instead of looking like success.
do $$
declare
  n_rewards int;
  n_rules   int;
begin
  select count(*) into n_rewards from public.rewards where id::text like '5eed0000-%';
  select count(*) into n_rules   from public.rules   where id::text like '5eed0000-%';
  if n_rewards <> 12 or n_rules <> 12 then
    raise exception 'seed_rewards: expected 12 rewards and 12 rules, found % and %', n_rewards, n_rules;
  end if;
end;
$$;
