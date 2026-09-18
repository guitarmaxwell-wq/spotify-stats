/**
 * Last.fm `user.getRecentTracks` — the only source that can backfill a shelf.
 *
 * A username and an app-level API key. No OAuth, no user token, no per-user
 * allowlist, no approval from anyone. That is what makes this the path the app
 * can actually ship with; see `docs/DATA_SOURCES.md`.
 *
 * Two paging details that are easy to get wrong and expensive to debug:
 *
 * 1. **The window is pinned.** Every page passes the same `to=`, fixed at the
 *    start of the sync. Without it, scrobbles arriving mid-backfill shift page
 *    boundaries and tracks are skipped between pages.
 * 2. **Pages arrive newest-first**, so the cursor is only trustworthy once the
 *    final page has landed. Advancing per page would mark the user caught-up
 *    while their older history was still unfetched.
 */

import { LASTFM_API_KEY } from './config';
import { cleanArtist, cleanTitle } from './normalize';
import { type Cursor, type PlayEvent, type SyncResult, emptyResult } from './types';

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';
export const PAGE_SIZE = 200;

/**
 * How far behind the cursor an incremental sync re-reads.
 *
 * Offline scrobblers (a phone out of signal) upload batches carrying *old*
 * timestamps. Those land behind a tight cursor and would be lost forever.
 * Re-reading a fortnight costs a page or two and the store de-duplicates it.
 */
export const LOOKBACK_S = 14 * 24 * 3600;

export class LastfmError extends Error {}
export class LastfmUserNotFound extends LastfmError {}

const text = (node: any): string | null => {
  const v = typeof node === 'object' && node ? node['#text'] : node;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

const mbid = (node: any): string | null => {
  const v = typeof node === 'object' && node ? node.mbid : null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/** Last.fm returns a bare object instead of an array when there is one item. */
const asList = (v: any): any[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** One API track -> PlayEvent, or null when it is not a play yet. */
export function parseTrack(raw: any): PlayEvent | null {
  // The currently-playing track has no timestamp. It is not a play; it will
  // arrive properly on the next sync.
  if (String(raw?.['@attr']?.nowplaying ?? '').toLowerCase() === 'true') return null;
  const uts = Number(raw?.date?.uts);
  if (!uts) return null;
  const artist = text(raw.artist);
  const track = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!artist || !track) return null;
  return {
    ts: uts,
    artist: cleanArtist(artist),
    track: cleanTitle(track),
    album: text(raw.album) ? cleanTitle(text(raw.album)) : null,
    source: 'lastfm',
    artist_mbid: mbid(raw.artist),
    album_mbid: mbid(raw.album),
    track_mbid: typeof raw.mbid === 'string' && raw.mbid.trim() ? raw.mbid.trim() : null,
  };
}

interface Page {
  events: PlayEvent[];
  invalid: number;
  page: number;
  totalPages: number;
}

async function fetchPage(
  username: string,
  apiKey: string,
  page: number,
  fromUts: number,
  toUts: number,
): Promise<Page> {
  const params = new URLSearchParams({
    method: 'user.getrecenttracks',
    user: username,
    api_key: apiKey,
    format: 'json',
    limit: String(PAGE_SIZE),
    page: String(page),
  });
  if (fromUts) params.set('from', String(fromUts));
  if (toUts) params.set('to', String(toUts));

  const res = await fetch(`${API_ROOT}?${params}`);
  if (!res.ok) throw new LastfmError(`Last.fm returned HTTP ${res.status}`);
  const body = await res.json();

  if (body?.error) {
    if (body.error === 6) throw new LastfmUserNotFound(`No Last.fm user called “${username}”.`);
    throw new LastfmError(body.message ?? `Last.fm error ${body.error}`);
  }

  const recent = body?.recenttracks ?? {};
  const totalPages = Math.max(1, Number(recent['@attr']?.totalPages ?? 1) || 1);
  const events: PlayEvent[] = [];
  let invalid = 0;
  for (const raw of asList(recent.track)) {
    try {
      const ev = parseTrack(raw);
      if (ev) events.push(ev);
    } catch {
      invalid += 1;
    }
  }
  return { events, invalid, page, totalPages };
}

/** Does this username exist, and how many scrobbles does it have? */
export async function checkUser(username: string): Promise<{ playcount: number }> {
  if (!LASTFM_API_KEY) throw new LastfmError('Last.fm is not configured in this build.');
  const params = new URLSearchParams({
    method: 'user.getinfo',
    user: username,
    api_key: LASTFM_API_KEY,
    format: 'json',
  });
  const res = await fetch(`${API_ROOT}?${params}`);
  const body = await res.json();
  if (body?.error === 6) throw new LastfmUserNotFound(`No Last.fm user called “${username}”.`);
  if (body?.error) throw new LastfmError(body.message ?? 'Last.fm rejected the request.');
  return { playcount: Number(body?.user?.playcount ?? 0) };
}

export interface SyncOptions {
  full?: boolean;
  maxPages?: number;
  /** Called after each page, for a progress bar during a long backfill. */
  onPage?: (page: number, totalPages: number, added: number) => void;
  /** Persist one page's events; returns how many were new. */
  persist: (events: PlayEvent[]) => Promise<{ added: number; duplicates: number }>;
  /** Called once, only when the whole walk completed. */
  commitCursor: (lastTs: number) => Promise<void>;
}

/**
 * Sync one username. Incremental by default.
 *
 * A full re-walk is safe at any time — the store de-duplicates — it is just
 * slow: roughly one request per 200 scrobbles, at Last.fm's ~1 req/s.
 */
export async function sync(
  username: string,
  cursor: Cursor,
  opts: SyncOptions,
): Promise<SyncResult> {
  if (!LASTFM_API_KEY) throw new LastfmError('Last.fm is not configured in this build.');

  const result = emptyResult('lastfm');
  const maxPages = opts.maxPages ?? 5000;
  const fromUts =
    opts.full || !cursor.last_ts ? 0 : Math.max(0, cursor.last_ts - LOOKBACK_S);
  const toUts = Math.floor(Date.now() / 1000);

  let page = 1;
  let totalPages = 1;
  let truncated = false;

  while (page <= totalPages && page <= maxPages) {
    const got = await fetchPage(username, LASTFM_API_KEY, page, fromUts, toUts);
    totalPages = got.totalPages;
    const { added, duplicates } = await opts.persist(got.events);
    result.fetched += got.events.length;
    result.added += added;
    result.duplicates += duplicates;
    result.invalid += got.invalid;
    opts.onPage?.(page, totalPages, result.added);

    if (totalPages > maxPages) {
      truncated = true;
      result.warnings.push(`Stopped at page ${maxPages} of ${totalPages}. Sync again to continue.`);
      break;
    }
    page += 1;
  }

  if (!truncated) {
    // The window was pinned at toUts, so everything up to it is now stored —
    // even if every page came back empty, which is the normal case for a user
    // who has not listened to anything since the last sync.
    await opts.commitCursor(toUts);
  }
  return result;
}
