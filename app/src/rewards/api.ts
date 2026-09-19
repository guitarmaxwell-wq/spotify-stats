/**
 * Every network call the rewards feature makes, and nothing else, lives here.
 *
 * The rest of the app talks to `RewardsApi`, never to supabase-js directly, so
 * the whole backend can be swapped for a stub (see `stub.ts`) while the Edge
 * Functions are still being built, and so there is one file to read to know
 * exactly what the app sends.
 *
 * Trust model (docs/REWARDS.md section 2): this app is UNTRUSTED. It never
 * uploads play counts and never writes a grant. It reads its own rows through
 * row-level security and asks Edge Functions to do everything else. The only
 * key in here is the publishable one, which is designed to ship in the app.
 */

import { createClient, processLock, type SupabaseClient } from '@supabase/supabase-js';
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import * as WebBrowser from 'expo-web-browser';
import { AppState, Platform } from 'react-native';

import { parseLastfmReturn } from './messages';
import { secureSessionStorage } from './secureSession';
import {
  RewardsError,
  type EarnedReward,
  type LinkedLastfm,
  type LinkOutcome,
  type MilkUser,
  type RewardKind,
  type SyncStep,
} from './types';

export const SUPABASE_URL: string | undefined = process.env.EXPO_PUBLIC_SUPABASE_URL || undefined;
const PUBLISHABLE_KEY: string | undefined =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || undefined;

/** Where the email sign-in link sends the user. Must be allowlisted in Supabase Auth. */
export const EMAIL_REDIRECT = 'milk://auth/callback';
/** Where `lastfm-auth-complete` sends the user back (section 9). */
export const LASTFM_RETURN = 'milk://auth/lastfm';

export interface RewardsApi {
  /** False when this build has no Supabase URL/key; the feature then hides itself. */
  readonly configured: boolean;
  /** True when this is fake data (dev only). The UI says so. */
  readonly stub: boolean;

  currentUser(): Promise<MilkUser | null>;
  onUserChange(cb: (user: MilkUser | null) => void): () => void;
  /** Emails a sign-in link that also carries a 6-digit code. */
  sendEmailSignIn(email: string): Promise<void>;
  verifyEmailCode(email: string, code: string): Promise<void>;
  /** Completes sign-in from a `milk://auth/callback` deep link. True if handled. */
  completeEmailLink(url: string): Promise<boolean>;
  signOut(): Promise<void>;

  /** Runs the whole Last.fm web-auth round trip, browser included. */
  linkLastfm(): Promise<LinkOutcome>;
  /** One bounded `lastfm-sync` chunk. Call until `done`. */
  syncLastfmStep(): Promise<SyncStep>;
  linkedLastfm(): Promise<LinkedLastfm | null>;
  myRewards(): Promise<EarnedReward[]>;
}

// ------------------------------------------------------------------ client --

let client: SupabaseClient | null = null;

function db(): SupabaseClient {
  if (!SUPABASE_URL || !PUBLISHABLE_KEY) {
    throw new RewardsError('Milk accounts are not configured in this build.', true);
  }
  if (!client) {
    client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
      auth: {
        storage: secureSessionStorage,
        autoRefreshToken: true,
        persistSession: true,
        // Native apps receive the sign-in link through a deep link, handled
        // explicitly in completeEmailLink, not by sniffing window.location.
        detectSessionInUrl: false,
        // PKCE: the link carries a one-time code that is useless without the
        // verifier this device keeps in the keychain.
        flowType: 'pkce',
        // navigator.locks does not exist in React Native.
        lock: processLock,
      },
    });
    // Refresh tokens only while the app is in the foreground (Supabase's own
    // guidance for React Native), so a backgrounded app is not looping.
    if (Platform.OS !== 'web') {
      AppState.addEventListener('change', (state) => {
        if (state === 'active') client?.auth.startAutoRefresh();
        else client?.auth.stopAutoRefresh();
      });
    }
  }
  return client;
}

const toUser = (u: { id: string; email?: string | null } | null | undefined): MilkUser | null =>
  u ? { id: u.id, email: u.email ?? null } : null;

/** Turns any supabase-js failure into one sentence a person can act on. */
async function explain(error: unknown, what: string): Promise<RewardsError> {
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response | undefined;
    if (res?.status === 404) {
      return new RewardsError(`${what} isn't available yet. The server side is still being set up.`, true);
    }
    if (res?.status === 401) {
      return new RewardsError('Your sign-in has expired. Sign in again to continue.');
    }
    let detail = '';
    try {
      const body = await res?.json();
      detail = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : '';
    } catch {
      /* not JSON */
    }
    // Machine codes the functions return, said the way a person would.
    const known: Record<string, string> = {
      no_verified_lastfm_account:
        "Your Last.fm isn't verified yet. Tap Connect Last.fm and approve Milk on Last.fm's page first.",
      server_error: `${what} hit a problem on Milk's side. Nothing was lost; please try again in a minute.`,
      unauthorized: 'Your sign-in has expired. Sign in again to continue.',
    };
    if (known[detail]) return new RewardsError(known[detail]);
    return new RewardsError(`${what} failed${detail ? `: ${detail}` : ` (HTTP ${res?.status ?? '?'})`}.`);
  }
  if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) {
    return new RewardsError(`Couldn't reach Milk's server for ${what.toLowerCase()}. Check your connection and try again.`, true);
  }
  if (error instanceof RewardsError) return error;
  const msg = error instanceof Error ? error.message : String(error);
  return new RewardsError(`${what} failed: ${msg}`);
}

async function invoke<T>(name: string, what: string): Promise<T> {
  const { data, error } = await db().functions.invoke<T>(name, { method: 'POST', body: {} });
  if (error) throw await explain(error, what);
  if (data == null) throw new RewardsError(`${what} returned nothing.`);
  return data;
}

function paramsOf(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = [url.split('?')[1]?.split('#')[0], url.split('#')[1]].filter(Boolean).join('&');
  for (const pair of raw.split('&')) {
    const [k, v = ''] = pair.split('=');
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

// --------------------------------------------------------------------- api --

export const realApi: RewardsApi = {
  configured: Boolean(SUPABASE_URL && PUBLISHABLE_KEY),
  stub: false,

  async currentUser() {
    if (!this.configured) return null;
    // getSession reads local storage only: no network, so this is safe offline.
    const { data } = await db().auth.getSession();
    return toUser(data.session?.user);
  },

  onUserChange(cb) {
    if (!this.configured) return () => {};
    const { data } = db().auth.onAuthStateChange((_event, session) => cb(toUser(session?.user)));
    return () => data.subscription.unsubscribe();
  },

  async sendEmailSignIn(email) {
    const { error } = await db().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: EMAIL_REDIRECT, shouldCreateUser: true },
    });
    if (error) throw await explain(error, 'Sending the sign-in email');
  },

  async verifyEmailCode(email, code) {
    const { error } = await db().auth.verifyOtp({ email, token: code, type: 'email' });
    if (error) throw new RewardsError("That code didn't work. It may have expired; request a new one.");
  },

  async completeEmailLink(url) {
    if (!url.startsWith(EMAIL_REDIRECT)) return false;
    const p = paramsOf(url);
    if (p.error_description || p.error) {
      throw new RewardsError(
        `That sign-in link didn't work (${p.error_description ?? p.error}). Request a new one.`,
      );
    }
    if (p.code) {
      const { error } = await db().auth.exchangeCodeForSession(p.code);
      if (error) {
        throw new RewardsError(
          'That sign-in link was opened on a different device or has already been used. Type the 6-digit code instead, or request a new link.',
        );
      }
      return true;
    }
    if (p.access_token && p.refresh_token) {
      const { error } = await db().auth.setSession({
        access_token: p.access_token,
        refresh_token: p.refresh_token,
      });
      if (error) throw await explain(error, 'Signing in');
      return true;
    }
    return false;
  },

  async signOut() {
    // 'local': forget this device's session without a network round trip, so
    // signing out works offline too.
    await db().auth.signOut({ scope: 'local' });
  },

  async linkLastfm() {
    const { url } = await invoke<{ url: string }>('lastfm-auth-start', 'Starting the Last.fm link');
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
      throw new RewardsError('The server returned an unusable Last.fm link.');
    }
    const result = await WebBrowser.openAuthSessionAsync(url, LASTFM_RETURN);
    if (result.type === 'success') {
      const { status, reason } = parseLastfmReturn(result.url);
      if (status === 'ok') return { status: 'ok' };
      return { status: 'error', reason: reason ?? 'server_error' };
    }
    // No redirect reached us. That happens on web (a browser cannot follow
    // milk://) and occasionally on Android. The approval may still have
    // landed, so ask the server rather than guess.
    const linked = await this.linkedLastfm().catch(() => null);
    if (linked?.verifiedAt) return { status: 'ok' };
    return { status: 'cancelled' };
  },

  async syncLastfmStep() {
    const step = await invoke<SyncStep>('lastfm-sync', 'Syncing Last.fm');
    if (step.busy) return { done: false, pages_processed: 0, plays_added: 0, granted: 0, busy: true };
    return {
      done: Boolean(step.done),
      pages_processed: Number(step.pages_processed) || 0,
      plays_added: Number(step.plays_added) || 0,
      granted: Number(step.granted) || 0,
    };
  },

  async linkedLastfm() {
    const { data, error } = await db()
      .from('linked_accounts')
      .select('external_id, verified_at, last_synced_at')
      .eq('provider', 'lastfm')
      .maybeSingle();
    if (error) throw await explain(error, 'Checking your Last.fm link');
    if (!data) return null;
    return {
      username: data.external_id as string,
      verifiedAt: (data.verified_at as string | null) ?? null,
      lastSyncedAt: (data.last_synced_at as string | null) ?? null,
    };
  },

  async myRewards() {
    const { data, error } = await db()
      .from('user_rewards')
      .select(
        'reward_id, subject_key, granted_at, evidence, rewards(kind, name, description, art_url, subject_kind)',
      )
      .order('granted_at', { ascending: false });
    if (error) throw await explain(error, 'Loading your stickers');

    type Row = {
      reward_id: string;
      subject_key: string;
      granted_at: string;
      evidence: Record<string, unknown> | null;
      rewards: {
        kind: RewardKind;
        name: string;
        description: string | null;
        art_url: string | null;
        subject_kind: 'artist' | 'album' | null;
      } | null;
    };
    const rows = ((data ?? []) as unknown as Row[]).filter((r) => r.rewards);

    // Wildcard grants carry only a subject key (an MBID, or `name:<artistKey>`
    // for artists MusicBrainz does not know). Resolve those to names in one
    // query per catalog table.
    const artistKeys = rows.filter((r) => r.subject_key && r.rewards?.subject_kind !== 'album').map((r) => r.subject_key);
    const albumKeys = rows.filter((r) => r.subject_key && r.rewards?.subject_kind === 'album').map((r) => r.subject_key);
    const names = new Map<string, string>();
    if (artistKeys.length) {
      const { data: artists } = await db().from('artists').select('mbid, name').in('mbid', [...new Set(artistKeys)]);
      for (const a of artists ?? []) names.set(a.mbid as string, a.name as string);
    }
    if (albumKeys.length) {
      const { data: albums } = await db()
        .from('albums')
        .select('release_mbid, title')
        .in('release_mbid', [...new Set(albumKeys)]);
      for (const a of albums ?? []) names.set(a.release_mbid as string, a.title as string);
    }

    return rows.map((r) => {
      const rw = r.rewards!;
      const key = r.subject_key ?? '';
      return {
        key: `${r.reward_id}:${key}`,
        rewardId: r.reward_id,
        kind: rw.kind,
        name: rw.name,
        description: rw.description,
        artUrl: rw.art_url,
        subjectKey: key,
        subjectName: key ? names.get(key) ?? fallbackSubjectName(key) : null,
        subjectKind: rw.subject_kind,
        grantedAt: r.granted_at,
        evidence: r.evidence ?? {},
      };
    });
  },
};

/** `name:the-beatles` -> "the beatles". A bare MBID says nothing to a person. */
function fallbackSubjectName(key: string): string | null {
  if (key.startsWith('name:')) return key.slice(5).replace(/[-_]+/g, ' ').trim() || null;
  return null;
}
