/**
 * Where the Milk account session lives: `expo-secure-store`, never AsyncStorage.
 *
 * Same rules as `link/tokens.ts`, for the same reasons: the refresh token is a
 * long-lived credential, so it goes in the iOS keychain / Android Keystore, and
 * on web (where SecureStore does not exist) it is held in memory for the tab's
 * life only rather than quietly falling back to localStorage.
 *
 * One problem is specific to this file. supabase-js stores the whole session as
 * one JSON string -- access token, refresh token and user object -- which is
 * routinely 2-4KB, and some iOS releases refuse SecureStore values over about
 * 2KB. So each value is split into chunks under numbered keys, with a small
 * header recording how many there are.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const SERVICE = 'com.maxwell.milk.session';
/** Well under the ~2KB ceiling, leaving room for multi-byte characters. */
const CHUNK = 1800;

const onWeb = Platform.OS === 'web';
const memory = new Map<string, string>();

/** SecureStore keys may contain only alphanumerics, `.`, `-` and `_`. */
const safe = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_');
const countKey = (key: string) => `${safe(key)}.n`;
const partKey = (key: string, i: number) => `${safe(key)}.${i}`;

const opts = { keychainService: SERVICE };

async function rawGet(k: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(k, opts);
  } catch {
    // An entry invalidated by a passcode change reads as an error. That means
    // "signed out", not "crash the app".
    return null;
  }
}

async function rawDelete(k: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(k, opts);
  } catch {
    /* already gone */
  }
}

async function removeItem(key: string): Promise<void> {
  if (onWeb) {
    memory.delete(key);
    return;
  }
  const n = Number((await rawGet(countKey(key))) ?? 0);
  await rawDelete(countKey(key));
  await Promise.all(Array.from({ length: n }, (_, i) => rawDelete(partKey(key, i))));
}

async function getItem(key: string): Promise<string | null> {
  if (onWeb) return memory.get(key) ?? null;
  const n = Number((await rawGet(countKey(key))) ?? 0);
  if (!n) return null;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const part = await rawGet(partKey(key, i));
    // A missing chunk means a torn write. Half a session is no session.
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join('');
}

async function setItem(key: string, value: string): Promise<void> {
  if (onWeb) {
    memory.set(key, value);
    return;
  }
  const previous = Number((await rawGet(countKey(key))) ?? 0);
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += CHUNK) parts.push(value.slice(i, i + CHUNK));
  for (let i = 0; i < parts.length; i++) {
    await SecureStore.setItemAsync(partKey(key, i), parts[i], opts);
  }
  await SecureStore.setItemAsync(countKey(key), String(parts.length), opts);
  // A shorter value leaves stale trailing chunks behind; clear them.
  for (let i = parts.length; i < previous; i++) await rawDelete(partKey(key, i));
}

/** The storage adapter supabase-js expects. */
export const secureSessionStorage = { getItem, setItem, removeItem };

export const sessionPersists = (): boolean => !onWeb;
