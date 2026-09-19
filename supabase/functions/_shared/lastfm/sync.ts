/**
 * The resumable, exact Last.fm walk. Storage-agnostic: the Edge Function plugs
 * in the Postgres store (store.ts); the test harness plugs in an in-memory one.
 *
 * ## Why the counts are exact
 *
 * Two independent guarantees, and each alone would not be enough:
 *
 * A. **Every scrobble in the window is seen at least once** (the walk).
 *    A sync pins a half-open window [from, to) at its start. It then walks
 *    newest-first by SHRINKING `to`, not by page number: it asks for page 1 of
 *    [from, walkTo), and if the oldest scrobble on that page is at second m,
 *    every scrobble in [m+1, walkTo) was on that page (page 1 is the newest
 *    200). So walkTo := m+1 keeps the invariant "everything in [walkTo, to) has
 *    been ingested". `to` is EXCLUSIVE (verified live), so the next request
 *    re-reads second m: a tie at m that spilled past the page is not lost.
 *    Because each request is anchored to a timestamp rather than a page offset,
 *    a scrobble added or deleted between calls cannot shift a page boundary
 *    and make the walk skip anything. When page >= totalPages, the rest of the
 *    window was on that page, and the sync is done.
 *
 * B. **No scrobble is counted twice** (the ledger). Every scrobble is inserted
 *    into `lastfm_scrobbles` keyed by (user, uts, artist, track); duplicates are
 *    ignored, and artist_plays is re-derived from the ledger. So re-reading the
 *    boundary second, the 14-day look-back, a retried call, or two overlapping
 *    syncs can only ever re-see a scrobble, never re-count it.
 *
 * The look-back (next sync starts at cursor - 14 days) exists for late
 * scrobbles: offline scrobblers upload plays with old timestamps, which a tight
 * cursor would miss forever. (A) + (B) make the overlap free of double counts.
 *
 * The now-playing track has no timestamp and is never ingested (api.ts).
 *
 * The one theoretical gap: if more than 200 scrobbles share ONE second, the walk
 * cannot shrink `to` and falls back to page numbers within that second, where a
 * concurrent deletion could shift a boundary. Double counting is still
 * impossible (B); at worst one such scrobble is missed until the next sync.
 */

import { artistKey } from "./normalize.ts";
import { getRecentTracks, MIN_REQUEST_GAP_MS, type RecentPage, type Scrobble } from "./api.ts";

/** How far behind the committed cursor an incremental sync re-reads. */
export const LOOKBACK_S = 14 * 24 * 3600;

export interface Window {
  from: number | null;
  to: number;
  walkTo: number;
  walkPage: number;
}

export interface Step {
  done: boolean;
  nextTo: number | null;
  nextPage: number | null;
}

/** Pure: where the walk goes after fetching page `w.walkPage` of [from, walkTo). */
export function nextStep(w: Window, page: RecentPage): Step {
  if (w.walkPage >= page.totalPages) return { done: true, nextTo: null, nextPage: null };
  if (page.scrobbles.length === 0) {
    // Only unparseable items on this page, but more pages exist: step past it.
    return { done: false, nextTo: w.walkTo, nextPage: w.walkPage + 1 };
  }
  let min = Infinity;
  for (const s of page.scrobbles) if (s.uts < min) min = s.uts;
  const candidate = min + 1;
  if (candidate < w.walkTo) return { done: false, nextTo: candidate, nextPage: 1 };
  // The whole page sits in the second just below walkTo: page within it.
  return { done: false, nextTo: w.walkTo, nextPage: w.walkPage + 1 };
}

export interface IngestRow {
  uts: number;
  artist: string;
  track: string;
  key: string;
  mbid: string | null;
}

export function toRows(scrobbles: Scrobble[]): IngestRow[] {
  const rows: IngestRow[] = [];
  for (const s of scrobbles) {
    const key = artistKey(s.artist);
    if (!key) continue; // cannot happen for a non-empty name; never invent an identity
    rows.push({ uts: s.uts, artist: s.artist, track: s.track, key, mbid: s.mbid });
  }
  return rows;
}

export type BeginResult =
  | { status: "ok"; window: Window }
  | { status: "busy" }
  | { status: "idle_recent" };

export interface SyncStore {
  begin(): Promise<BeginResult>;
  /** Atomic: insert rows into the ledger AND move the walk (compare-and-set on `expect`). */
  ingest(
    expect: { walkTo: number; walkPage: number },
    rows: IngestRow[],
    step: Step,
  ): Promise<{ applied: boolean; inserted: number }>;
  release(): Promise<void>;
}

export type PageFetcher = (
  q: { page: number; from: number | null; to: number },
) => Promise<RecentPage>;

export function lastfmFetcher(user: string, apiKey: string, fetchFn: typeof fetch = fetch): PageFetcher {
  let last = 0;
  return async (q) => {
    const wait = last + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return await getRecentTracks({ user, apiKey, ...q }, fetchFn);
  };
}

export interface ChunkResult {
  done: boolean;
  busy: boolean;
  pagesProcessed: number;
  playsAdded: number;
}

/**
 * Walk at most `maxPages` pages or `budgetMs` of wall clock, whichever first.
 * Progress is persisted after every page, so a call killed mid-chunk loses at
 * most the page in flight, and re-fetching it is harmless.
 */
export async function runChunk(opts: {
  store: SyncStore;
  fetchPage: PageFetcher;
  maxPages: number;
  budgetMs: number;
  now?: () => number;
}): Promise<ChunkResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const b = await opts.store.begin();
  if (b.status === "busy") return { done: false, busy: true, pagesProcessed: 0, playsAdded: 0 };
  if (b.status === "idle_recent") return { done: true, busy: false, pagesProcessed: 0, playsAdded: 0 };

  const w = { ...b.window };
  let pages = 0;
  let added = 0;
  let done = false;
  try {
    while (pages < opts.maxPages && now() - started < opts.budgetMs) {
      const page = await opts.fetchPage({ page: w.walkPage, from: w.from, to: w.walkTo });
      const step = nextStep(w, page);
      const res = await opts.store.ingest({ walkTo: w.walkTo, walkPage: w.walkPage }, toRows(page.scrobbles), step);
      if (!res.applied) break; // someone else moved the walk; the next call resumes from theirs
      pages++;
      added += res.inserted;
      if (step.done) {
        done = true;
        break;
      }
      w.walkTo = step.nextTo!;
      w.walkPage = step.nextPage!;
    }
  } finally {
    await opts.store.release();
  }
  return { done, busy: false, pagesProcessed: pages, playsAdded: added };
}
