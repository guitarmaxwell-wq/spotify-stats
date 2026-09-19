-- Rewards core: the schema from docs/REWARDS.md, section 3.
--
-- The organising principle is the trust model in section 2. Anything that
-- decides whether a reward was earned -- play counts, verification, grants --
-- is written ONLY by the server (service role, which bypasses RLS). Clients get
-- read access to their own rows and nothing else. That is not belt-and-braces:
-- community access gates other people's space, so a client able to write its
-- own play count could walk into any gated community.

-- ---------------------------------------------------------------- helpers --

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- people --

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 60),
  created_at   timestamptz not null default now()
);

-- Every new auth user gets a profile, so no code path has to remember to make one.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Is the calling user an admin? SECURITY DEFINER so it can read `admins`, which
-- clients cannot see at all; `set search_path` closes the classic hijack where a
-- caller shadows `admins` with a table of their own.
--
-- Defined here, after `admins`, not with the other helpers: a `language sql`
-- function's body is checked when it is created, so it cannot refer to a table
-- that does not exist yet.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ----------------------------------------------------------- linked accounts

create table public.linked_accounts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  provider       text not null check (provider in ('lastfm', 'spotify')),
  external_id    text not null,
  -- Null until ownership is PROVEN (Last.fm web auth / Spotify OAuth). Plays from
  -- an unverified account never count toward anything.
  verified_at    timestamptz,
  cursor_ts      bigint,
  last_synced_at timestamptz,
  created_at     timestamptz not null default now(),
  -- One external account, one owner. Without this, anyone could claim someone
  -- else's public Last.fm username and inherit their history.
  unique (provider, external_id),
  unique (user_id, provider)
);

-- The session key lives apart from linked_accounts deliberately. Row-level
-- security cannot hide a column: had it been a column there, a user could SELECT
-- it. This table has RLS enabled and no client policies at all.
create table public.linked_account_secrets (
  linked_account_id uuid primary key references public.linked_accounts (id) on delete cascade,
  session_key       text not null,
  updated_at        timestamptz not null default now()
);

-- -------------------------------------------------------------- catalog --

create table public.artists (
  id    uuid primary key default gen_random_uuid(),
  mbid  text not null unique,
  name  text not null
);

create table public.albums (
  id           uuid primary key default gen_random_uuid(),
  release_mbid text not null unique,
  artist_id    uuid references public.artists (id),
  title        text not null,
  -- Ordered list of normalized track keys. Album rules need this server-side,
  -- which is why they are milestone 1b and artist rules are 1a.
  tracklist    jsonb not null default '[]'::jsonb check (jsonb_typeof(tracklist) = 'array'),
  cover_url    text,
  colors       jsonb,
  fetched_at   timestamptz not null default now()
);

-- ------------------------------------------------------------- aggregates --

create table public.artist_plays (
  user_id    uuid not null references auth.users (id) on delete cascade,
  artist_id  uuid not null references public.artists (id) on delete cascade,
  plays      integer not null default 0 check (plays >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, artist_id)
);

create table public.track_plays (
  user_id   uuid not null references auth.users (id) on delete cascade,
  album_id  uuid not null references public.albums (id) on delete cascade,
  track_key text not null,
  plays     integer not null default 0 check (plays >= 0),
  primary key (user_id, album_id, track_key)
);

-- ------------------------------------------------------------- rewards --

create table public.rewards (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('sticker', 'poster', 'community')),
  name         text not null,
  description  text,
  art_url      text,
  -- A reward with subject_kind set and no specific artist/album is a TEMPLATE:
  -- a wildcard rule grants one per subject ("the Radiohead community", "the
  -- Nujabes community"), not a single global reward.
  subject_kind text check (subject_kind in ('artist', 'album')),
  artist_id    uuid references public.artists (id),
  album_id     uuid references public.albums (id),
  created_at   timestamptz not null default now(),
  check (not (artist_id is not null and album_id is not null))
);

create table public.rules (
  id         uuid primary key default gen_random_uuid(),
  -- Rule TYPES are code (docs/REWARDS.md section 1). Adding one is a migration
  -- plus an evaluator, reviewed; tuning a rule is a row edit.
  type       text not null check (type in (
               'artist_plays',
               'album_unlocked',
               'album_passes',
               'artist_albums_unlocked',
               'albums_unlocked'
             )),
  params     jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  reward_id  uuid not null references public.rewards (id) on delete restrict,
  active     boolean not null default true,
  starts_at  timestamptz,
  ends_at    timestamptz,
  notes      text,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create trigger rules_touch
  before update on public.rules
  for each row execute function public.touch_updated_at();

create table public.user_rewards (
  user_id     uuid not null references auth.users (id) on delete cascade,
  reward_id   uuid not null references public.rewards (id) on delete cascade,
  -- The artist or album MBID this grant is ABOUT, or '' for rewards with no
  -- subject (e.g. "100 albums unlocked"). Text, not a foreign key, so a grant
  -- survives the catalog being rebuilt.
  subject_key text not null default '',
  rule_id     uuid references public.rules (id) on delete set null,
  granted_at  timestamptz not null default now(),
  -- WHY it was granted, e.g. {"plays": 184, "threshold": 182}, so a disputed
  -- grant can be explained later.
  evidence    jsonb not null default '{}'::jsonb,
  -- The idempotency key. Evaluating a user a hundred times never double-grants.
  primary key (user_id, reward_id, subject_key)
);

create index user_rewards_user_idx on public.user_rewards (user_id, granted_at desc);
create index rules_active_idx on public.rules (type) where active;
create index artist_plays_artist_idx on public.artist_plays (artist_id, plays desc);

-- ------------------------------------------------------ row-level security --
-- Enabled on EVERY table. A table with RLS disabled is readable and writable by
-- anyone holding the publishable key, which ships inside the app.

alter table public.profiles               enable row level security;
alter table public.admins                 enable row level security;
alter table public.linked_accounts        enable row level security;
alter table public.linked_account_secrets enable row level security;
alter table public.artists                enable row level security;
alter table public.albums                 enable row level security;
alter table public.artist_plays           enable row level security;
alter table public.track_plays            enable row level security;
alter table public.rewards                enable row level security;
alter table public.rules                  enable row level security;
alter table public.user_rewards           enable row level security;

-- profiles: read and edit your own.
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- admins, linked_account_secrets: NO client policies. Server only.

-- linked_accounts: read your own; NO client writes. An UPDATE policy cannot be
-- restricted by column, so allowing one would let a user set their own
-- verified_at. Linking happens only through the Edge Function.
create policy linked_accounts_select_own on public.linked_accounts
  for select to authenticated using (user_id = auth.uid());

-- Catalog, rules and rewards: public to read, admins to write. The rules are not
-- secret -- a fan being able to see "182 plays of Blink-182 earns a sticker" is
-- part of the game.
create policy artists_read on public.artists for select to anon, authenticated using (true);
create policy albums_read  on public.albums  for select to anon, authenticated using (true);
create policy rewards_read on public.rewards for select to anon, authenticated using (true);
create policy rules_read   on public.rules   for select to anon, authenticated using (true);

create policy artists_admin_write on public.artists
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy albums_admin_write on public.albums
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy rewards_admin_write on public.rewards
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy rules_admin_write on public.rules
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Aggregates and grants: read your own; NO client writes, ever.
create policy artist_plays_select_own on public.artist_plays
  for select to authenticated using (user_id = auth.uid());
create policy track_plays_select_own on public.track_plays
  for select to authenticated using (user_id = auth.uid());
create policy user_rewards_select_own on public.user_rewards
  for select to authenticated using (user_id = auth.uid());

-- --------------------------------------------------------------- storage --
-- Reward art. Public to read (it is shown on shelves), admins to upload.

insert into storage.buckets (id, name, public)
values ('reward-art', 'reward-art', true)
on conflict (id) do nothing;

create policy reward_art_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'reward-art' and public.is_admin());
create policy reward_art_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'reward-art' and public.is_admin());
create policy reward_art_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'reward-art' and public.is_admin());
