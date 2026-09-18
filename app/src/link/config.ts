/**
 * Configuration. **No credential is committed, and none is hardcoded here.**
 *
 * Values come from Expo public env vars, which are inlined at build time from
 * a gitignored `.env`. See `.env.example` at the repo root for what to create
 * and where.
 *
 * There is no client *secret* anywhere in this app, and there must never be.
 * The Spotify flow is PKCE precisely so that no secret has to ship; a secret in
 * a distributed binary is a secret you have published.
 */

/**
 * The Spotify app's client id. Public by design (PKCE), but still not
 * committed, because it is tied to *your* developer account's 25-user quota.
 *
 * Absent by default. There is no shared or stub value that could work: Spotify
 * binds the redirect URI and the allowlist to one specific app registration.
 */
export const SPOTIFY_CLIENT_ID: string | undefined =
  process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID || undefined;

/**
 * Last.fm API key. Also public-by-design — it identifies the app, not the user,
 * and `user.getRecentTracks` needs no user token at all. That property is the
 * entire reason the Last.fm path can ship publicly.
 */
export const LASTFM_API_KEY: string | undefined =
  process.env.EXPO_PUBLIC_LASTFM_API_KEY || undefined;

/** Must exactly match a redirect URI registered in the Spotify dashboard. */
export const REDIRECT_SCHEME = 'crates';
export const REDIRECT_PATH = 'auth';

export const SPOTIFY_SCOPES = ['user-read-recently-played'];

export const SPOTIFY_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};

export const isSpotifyConfigured = (): boolean => Boolean(SPOTIFY_CLIENT_ID);
export const isLastfmConfigured = (): boolean => Boolean(LASTFM_API_KEY);

/** Shown in the UI when a path is unavailable, so the failure is explicable. */
export const SPOTIFY_SETUP_HINT =
  'Spotify sign-in is not configured in this build. It needs a client ID that ' +
  'you create yourself at developer.spotify.com/dashboard, with ' +
  `${REDIRECT_SCHEME}://${REDIRECT_PATH} registered as a redirect URI, set as ` +
  'EXPO_PUBLIC_SPOTIFY_CLIENT_ID. See ingest/README.md.';

export const LASTFM_SETUP_HINT =
  'Last.fm is not configured in this build. It needs an API key from ' +
  'last.fm/api/account/create, set as EXPO_PUBLIC_LASTFM_API_KEY. ' +
  'See ingest/README.md.';
