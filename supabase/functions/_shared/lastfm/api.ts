/**
 * Minimal Last.fm API client for the Edge Functions.
 *
 * Facts this relies on, checked against the docs AND the live API
 * (2026-09-19), because the sync's exactness argument depends on them:
 *
 * - `user.getRecentTracks` `from` is INCLUSIVE and `to` is EXCLUSIVE. Probed
 *   live: a request with `to=T` omits the scrobble at exactly T; `from=T`
 *   includes it. The docs only say "after"/"before".
 * - The now-playing track carries `@attr.nowplaying="true"` and no `date`. It
 *   is not a scrobble yet and is never counted.
 * - A single item comes back as a bare object, not an array.
 * - Web auth: `cb` on https://www.last.fm/api/auth/ overrides the callback
 *   registered on the API account, and when `cb` already has a query string
 *   Last.fm appends `&token=...` (https://www.last.fm/api/webauth).
 * - api_sig: every param except `format` and `callback`, sorted by name,
 *   concatenated as <name><value>, then the shared secret, then md5 as hex.
 */

import { md5Hex } from "./md5.ts";

export { md5Hex };

export const API_ROOT = "https://ws.audioscrobbler.com/2.0/";
export const AUTH_ROOT = "https://www.last.fm/api/auth/";
export const PAGE_SIZE = 200;

export class LastfmError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/** Last.fm's api_sig. `format` and `callback` are excluded, per the docs. */
export function apiSig(params: Record<string, string>, secret: string): string {
  const body = Object.keys(params)
    .filter((k) => k !== "format" && k !== "callback")
    .sort()
    .map((k) => k + params[k])
    .join("");
  return md5Hex(body + secret);
}

export function authUrl(apiKey: string, callback: string): string {
  const q = new URLSearchParams({ api_key: apiKey, cb: callback });
  return `${AUTH_ROOT}?${q}`;
}

export type FetchFn = typeof fetch;

/** auth.getSession: exchange a web-auth token for { name, key }. */
export async function getSession(
  token: string,
  apiKey: string,
  secret: string,
  fetchFn: FetchFn = fetch,
): Promise<{ name: string; key: string }> {
  const params: Record<string, string> = { method: "auth.getSession", api_key: apiKey, token };
  const body = new URLSearchParams({ ...params, api_sig: apiSig(params, secret), format: "json" });
  const res = await fetchFn(API_ROOT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => null);
  if (json?.error) throw new LastfmError(String(json.message ?? "Last.fm error"), Number(json.error));
  const name = json?.session?.name;
  const key = json?.session?.key;
  if (!res.ok || typeof name !== "string" || typeof key !== "string" || !name || !key) {
    throw new LastfmError(`auth.getSession failed (HTTP ${res.status})`);
  }
  return { name, key };
}

/** One scrobble as the sync stores it. Raw names: they are the dedupe identity. */
export interface Scrobble {
  uts: number;
  artist: string;
  track: string;
  mbid: string | null;
}

export interface RecentPage {
  scrobbles: Scrobble[];
  /** Items skipped because they were now-playing or malformed. */
  skipped: number;
  totalPages: number;
  total: number;
}

const asList = (v: unknown): any[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function parseRecentTracks(body: any): RecentPage {
  const recent = body?.recenttracks ?? {};
  const attr = recent["@attr"] ?? {};
  const scrobbles: Scrobble[] = [];
  let skipped = 0;
  for (const raw of asList(recent.track)) {
    // Now playing: no date, not a play. Checked first and explicitly, so a
    // future API change that adds a date to it still cannot make it count.
    if (String(raw?.["@attr"]?.nowplaying ?? "").toLowerCase() === "true") {
      skipped++;
      continue;
    }
    const uts = Number(raw?.date?.uts);
    const artistNode = raw?.artist;
    const artist = typeof artistNode === "object" && artistNode
      ? (artistNode["#text"] ?? artistNode.name)
      : artistNode;
    const track = raw?.name;
    if (!Number.isSafeInteger(uts) || uts <= 0 || typeof artist !== "string" || !artist.trim() ||
      typeof track !== "string") {
      skipped++;
      continue;
    }
    const m = typeof artistNode?.mbid === "string" ? artistNode.mbid.trim().toLowerCase() : "";
    scrobbles.push({ uts, artist, track, mbid: m || null });
  }
  return {
    scrobbles,
    skipped,
    totalPages: Math.max(0, Number(attr.totalPages ?? 0) || 0),
    total: Math.max(0, Number(attr.total ?? 0) || 0),
  };
}

/**
 * Space requests out. Last.fm asks for no more than 5 requests/second averaged
 * over 5 minutes per originating IP; one sync at a time stays well under.
 */
export const MIN_REQUEST_GAP_MS = 250;

export async function getRecentTracks(
  opts: { user: string; apiKey: string; page: number; from?: number | null; to: number },
  fetchFn: FetchFn = fetch,
): Promise<RecentPage> {
  const q = new URLSearchParams({
    method: "user.getrecenttracks",
    user: opts.user,
    api_key: opts.apiKey,
    format: "json",
    limit: String(PAGE_SIZE),
    page: String(opts.page),
    to: String(opts.to),
  });
  if (opts.from != null && opts.from > 0) q.set("from", String(opts.from));
  let lastErr: unknown;
  // Last.fm intermittently answers 500/503 or error 8/11/16 ("try again").
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * attempt));
    try {
      const res = await fetchFn(`${API_ROOT}?${q}`);
      const json = await res.json().catch(() => null);
      if (json?.error) {
        const code = Number(json.error);
        lastErr = new LastfmError(String(json.message ?? `Last.fm error ${code}`), code);
        if (code === 8 || code === 11 || code === 16 || code === 29) continue;
        throw lastErr;
      }
      if (!res.ok || !json?.recenttracks) {
        lastErr = new LastfmError(`Last.fm returned HTTP ${res.status}`);
        continue;
      }
      return parseRecentTracks(json);
    } catch (e) {
      if (e instanceof LastfmError && e.code && ![8, 11, 16, 29].includes(e.code)) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new LastfmError("Last.fm request failed");
}
