/**
 * Spotify: PKCE sign-in, token refresh, and incremental forward sync.
 *
 * **What this can and cannot do.** It can keep a shelf filling from the moment
 * the user links, forever, reliably. It cannot import a single play from before
 * that moment. `recently-played` retains roughly the last 50 plays and its
 * `before`/`after` cursors only move inside that buffer; there is no historical
 * endpoint. Any UI built on this module must say so — see `docs/DATA_SOURCES.md`.
 *
 * PKCE (RFC 7636) is used because this is a distributed mobile app and there is
 * therefore nowhere safe to put a client secret. `expo-auth-session` defaults
 * `usePKCE` to true and `codeChallengeMethod` to S256; both are set explicitly
 * below so that a future default change cannot silently weaken the flow.
 */

import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  REDIRECT_PATH,
  REDIRECT_SCHEME,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_DISCOVERY,
  SPOTIFY_SCOPES,
} from './config';
import { cleanArtist, cleanTitle } from './normalize';
import {
  clearSpotifyTokens,
  isExpired,
  loadSpotifyTokens,
  saveSpotifyTokens,
  type SpotifyTokens,
} from './tokens';
import { type Cursor, type PlayEvent, type SyncResult, afterMs, emptyResult } from './types';

// Required on web to close the popup once the redirect lands. A no-op native.
WebBrowser.maybeCompleteAuthSession();

const RECENTLY_PLAYED = 'https://api.spotify.com/v1/me/player/recently-played';

/** Spotify's documented max, and also the entire size of the buffer. */
export const PAGE_LIMIT = 50;

/**
 * 50 tracks is roughly three hours of continuous listening. Polling every 30
 * minutes leaves a wide margin before plays start ageing out unseen.
 */
export const SUGGESTED_POLL_INTERVAL_MS = 30 * 60 * 1000;

export const redirectUri = (): string =>
  AuthSession.makeRedirectUri({ scheme: REDIRECT_SCHEME, path: REDIRECT_PATH });

export class SpotifyAuthError extends Error {}

/**
 * The PKCE sign-in hook.
 *
 * Returns `request: null` when no client id is configured, which the screen
 * uses to disable the button and explain why rather than failing at tap time.
 */
export function useSpotifyAuth(onTokens: (t: SpotifyTokens) => void) {
  const [error, setError] = useState<string | null>(null);
  const [exchanging, setExchanging] = useState(false);
  const uri = useMemo(redirectUri, []);

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: SPOTIFY_CLIENT_ID ?? '',
      redirectUri: uri,
      scopes: SPOTIFY_SCOPES,
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
      codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
    },
    SPOTIFY_DISCOVERY,
  );

  useEffect(() => {
    if (!response) return;
    if (response.type === 'error') {
      setError(response.params?.error_description ?? response.error?.message ?? 'Sign-in failed.');
      return;
    }
    if (response.type !== 'success' || !response.params?.code) return;

    let cancelled = false;
    setExchanging(true);
    (async () => {
      try {
        const token = await AuthSession.exchangeCodeAsync(
          {
            clientId: SPOTIFY_CLIENT_ID ?? '',
            redirectUri: uri,
            code: response.params.code,
            // The verifier the request generated. Without it the exchange is
            // rejected — this is the whole point of PKCE.
            extraParams: { code_verifier: request?.codeVerifier ?? '' },
          },
          SPOTIFY_DISCOVERY,
        );
        if (cancelled) return;
        const tokens = toTokens(token);
        await saveSpotifyTokens(tokens);
        onTokens(tokens);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setExchanging(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [response, request, uri, onTokens]);

  return {
    /** null when SPOTIFY_CLIENT_ID is unset, or while the request is building. */
    ready: Boolean(request && SPOTIFY_CLIENT_ID),
    exchanging,
    error,
    signIn: useCallback(() => promptAsync(), [promptAsync]),
    redirectUri: uri,
  };
}

function toTokens(t: AuthSession.TokenResponse): SpotifyTokens {
  return {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken ?? null,
    expiresAt: Math.floor((t.issuedAt ?? Date.now() / 1000) + (t.expiresIn ?? 3600)),
  };
}

/**
 * Return a usable access token, refreshing if needed.
 *
 * Every call that touches the API goes through here rather than reading the
 * stored token directly, so there is exactly one place that knows about expiry.
 */
export async function getFreshAccessToken(): Promise<string> {
  const stored = await loadSpotifyTokens();
  if (!stored) throw new SpotifyAuthError('Spotify is not linked.');
  if (!isExpired(stored)) return stored.accessToken;

  if (!stored.refreshToken) {
    await clearSpotifyTokens();
    throw new SpotifyAuthError('Spotify session expired. Please link again.');
  }
  if (!SPOTIFY_CLIENT_ID) throw new SpotifyAuthError('Spotify is not configured in this build.');

  try {
    const refreshed = await AuthSession.refreshAsync(
      { clientId: SPOTIFY_CLIENT_ID, refreshToken: stored.refreshToken },
      SPOTIFY_DISCOVERY,
    );
    const tokens = toTokens(refreshed);
    // Spotify may omit refresh_token on refresh, meaning "keep the old one".
    if (!tokens.refreshToken) tokens.refreshToken = stored.refreshToken;
    await saveSpotifyTokens(tokens);
    return tokens.accessToken;
  } catch (e) {
    // A rejected refresh token never becomes valid again. Clearing it turns a
    // permanent silent failure into a visible "link again".
    await clearSpotifyTokens();
    throw new SpotifyAuthError('Spotify session expired. Please link again.');
  }
}

export async function unlinkSpotify(): Promise<void> {
  await clearSpotifyTokens();
}

/** Spotify's `played_at` is ISO-8601 with ms, and marks when the track STOPPED. */
export function playedAtMs(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`unparseable played_at: ${value}`);
  return ms;
}

export function parseItem(item: any): PlayEvent {
  const track = item?.track ?? {};
  const artist = track.artists?.[0]?.name;
  if (!artist || !track.name) throw new Error('item is missing artist or track name');
  return {
    ts: Math.floor(playedAtMs(item.played_at) / 1000),
    artist: cleanArtist(artist),
    track: cleanTitle(track.name),
    album: track.album?.name ? cleanTitle(track.album.name) : null,
    source: 'spotify_recent',
    // No ms_played: the endpoint does not report it. Do not invent one.
    duration_ms: typeof track.duration_ms === 'number' ? track.duration_ms : null,
    foreign_id: track.uri ?? null,
  };
}

export interface RecentPage {
  events: PlayEvent[];
  invalid: number;
  /** Raw item count, needed to tell a full page from a short one. */
  rawCount: number;
  highWaterMs: number;
}

/**
 * One incremental poll.
 *
 * `after` is derived from a whole-second cursor, so the play sitting exactly on
 * the mark comes back once more each time. That is deliberate: the store
 * de-duplicates it for free, whereas rounding the cursor up to avoid it would
 * risk skipping a play instead.
 */
export async function fetchRecent(cursor: Cursor, limit = PAGE_LIMIT): Promise<RecentPage> {
  const token = await getFreshAccessToken();
  const params = new URLSearchParams({ limit: String(Math.min(limit, PAGE_LIMIT)) });
  const after = afterMs(cursor);
  if (after) params.set('after', String(after));

  const res = await fetch(`${RECENTLY_PLAYED}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new SpotifyAuthError('Spotify rejected the token.');
  if (res.status === 429) {
    const retry = Number(res.headers.get('Retry-After') ?? 1);
    throw new Error(`Spotify rate limited; retry in ${retry}s`);
  }
  if (!res.ok) throw new Error(`Spotify returned HTTP ${res.status}`);

  const body = await res.json();
  const items: any[] = body?.items ?? [];
  const events: PlayEvent[] = [];
  let invalid = 0;
  let highWaterMs = after;
  for (const item of items) {
    try {
      events.push(parseItem(item));
      highWaterMs = Math.max(highWaterMs, playedAtMs(item.played_at));
    } catch {
      invalid += 1;
    }
  }
  return { events, invalid, rawCount: items.length, highWaterMs };
}

/**
 * Was this poll likely to have missed plays?
 *
 * A page that comes back at the ceiling means Spotify had at least as many
 * plays as it was willing to give us, so older ones may have fallen out of the
 * 50-track buffer unseen. On the *first* sync a full page is expected (we are
 * draining the buffer), so it is only a gap when a cursor already existed.
 */
export function suspectsGap(page: RecentPage, cursor: Cursor, limit = PAGE_LIMIT): boolean {
  return page.rawCount >= Math.min(limit, PAGE_LIMIT) && Boolean(cursor.last_ts);
}

export const GAP_WARNING =
  'That sync came back full, so some plays may have aged out of Spotify’s ' +
  '50-track buffer before we saw them. Those plays cannot be recovered.';

export function summarize(page: RecentPage, cursor: Cursor, added: number, dupes: number): SyncResult {
  const result = emptyResult('spotify_recent');
  result.fetched = page.events.length;
  result.added = added;
  result.duplicates = dupes;
  result.invalid = page.invalid;
  if (suspectsGap(page, cursor)) result.warnings.push(GAP_WARNING);
  return result;
}
