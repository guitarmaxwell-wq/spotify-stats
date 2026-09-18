/**
 * Token storage — `expo-secure-store` only, never AsyncStorage.
 *
 * AsyncStorage is a plaintext file in the app sandbox. A refresh token there is
 * readable by anything that can read the sandbox, and on a jailbroken or rooted
 * device that is everything. SecureStore is the iOS keychain and the Android
 * Keystore.
 *
 * Two platform facts shape this module:
 *
 * 1. **SecureStore has a size limit.** iOS has historically rejected values
 *    over roughly 2KB. A Spotify token set is well under that, but we store
 *    the tokens as separate short keys rather than one JSON blob so we never
 *    drift toward the ceiling.
 * 2. **SecureStore does not exist on web.** `isAvailableAsync` is false there
 *    and every call throws. Rather than silently falling back to localStorage —
 *    which would be exactly the mistake this module exists to prevent — the web
 *    build keeps tokens in memory for the session only, and says so.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEYCHAIN_SERVICE = 'com.maxwell.crates.tokens';

const K_ACCESS = 'spotify_access_token';
const K_REFRESH = 'spotify_refresh_token';
const K_EXPIRES = 'spotify_expires_at';

export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Unix **seconds** at which `accessToken` stops working. */
  expiresAt: number;
}

/** Refresh this long before actual expiry, so a slow request cannot straddle it. */
export const REFRESH_SKEW_S = 120;

const memory = new Map<string, string>();
const useMemoryFallback = Platform.OS === 'web';

export const isPersistent = (): boolean => !useMemoryFallback;

export const PERSISTENCE_WARNING =
  'On web, tokens are held in memory for this session only — SecureStore is not ' +
  'available and browser storage is not an acceptable place for a refresh token. ' +
  'You will need to sign in again after a reload.';

async function put(key: string, value: string): Promise<void> {
  if (useMemoryFallback) {
    memory.set(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value, { keychainService: KEYCHAIN_SERVICE });
}

async function get(key: string): Promise<string | null> {
  if (useMemoryFallback) return memory.get(key) ?? null;
  try {
    return await SecureStore.getItemAsync(key, { keychainService: KEYCHAIN_SERVICE });
  } catch {
    // A keychain entry invalidated by a passcode change reads as an error, not
    // as null. Treat it as "not signed in" rather than crashing the screen.
    return null;
  }
}

async function drop(key: string): Promise<void> {
  if (useMemoryFallback) {
    memory.delete(key);
    return;
  }
  try {
    await SecureStore.deleteItemAsync(key, { keychainService: KEYCHAIN_SERVICE });
  } catch {
    /* already gone */
  }
}

export async function saveSpotifyTokens(t: SpotifyTokens): Promise<void> {
  await put(K_ACCESS, t.accessToken);
  await put(K_EXPIRES, String(t.expiresAt));
  if (t.refreshToken) {
    await put(K_REFRESH, t.refreshToken);
  }
  // Note the asymmetry: a refresh response may omit refresh_token, which means
  // "keep using the one you have", not "you no longer have one". Overwriting
  // it with null there would silently log the user out at the next expiry.
}

export async function loadSpotifyTokens(): Promise<SpotifyTokens | null> {
  const accessToken = await get(K_ACCESS);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: await get(K_REFRESH),
    expiresAt: Number((await get(K_EXPIRES)) ?? 0),
  };
}

export async function clearSpotifyTokens(): Promise<void> {
  await Promise.all([drop(K_ACCESS), drop(K_REFRESH), drop(K_EXPIRES)]);
}

export function isExpired(t: SpotifyTokens | null, nowS = Date.now() / 1000): boolean {
  if (!t) return true;
  return !t.expiresAt || t.expiresAt - REFRESH_SKEW_S <= nowS;
}

/** Last.fm needs only a public username — not a credential, so not in the keychain. */
export const LASTFM_USERNAME_KEY = 'crates.lastfm_username';
