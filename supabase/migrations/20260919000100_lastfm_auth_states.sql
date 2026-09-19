-- Binds a Last.fm approval to the Milk user who started it.
--
-- Last.fm's web auth redirects the browser back to our server with a token, but
-- the redirect itself says nothing trustworthy about WHICH Milk user approved
-- it. So before sending the user to Last.fm, the server mints a single-use,
-- short-lived nonce tied to their user id, passes it through the callback, and
-- on return accepts the token only if the nonce is valid, unexpired and unused.
--
-- Without this, an attacker could complete a Last.fm approval on their own
-- account and have it land on someone else's Milk user -- or replay a callback.

create table public.lastfm_auth_states (
  nonce      text primary key check (char_length(nonce) >= 32),
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  used_at    timestamptz
);

create index lastfm_auth_states_expiry_idx on public.lastfm_auth_states (expires_at);

-- Server only. RLS on with no client policies: clients never see or mint nonces.
alter table public.lastfm_auth_states enable row level security;
