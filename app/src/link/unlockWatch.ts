/**
 * Detects albums that finished while the user was away.
 *
 * This runs entirely on the device and needs no server and no MusicBrainz call,
 * because `collection.json` already ships `missing_tracks` for every unfinished
 * album -- the exact titles each record is still waiting on. Match new plays
 * against those titles and an album that runs out of missing tracks has just
 * been earned.
 *
 * The limit of that trick is worth stating: it can only finish albums the
 * collection already knows about. An album the user has never played at all is
 * absent from `collection.json`, has no tracklist here, and cannot be completed
 * on device -- that needs a pipeline rebuild, or the shared catalog service in
 * docs/CATALOG.md. See `pendingUnknownAlbums` below, which surfaces those rather
 * than letting them disappear.
 */

import type { Album, Collection } from '../types';
import type { PlayEvent } from './types';
import { matchKey, artistKey } from './normalize';

/** Where the seen-set lives. Bumped if the shape ever changes. */
const SEEN_FILE = 'unlocks-seen.v1.json';

export interface Unlock {
  album: Album;
  /**
   * The play that completed the album. Used to order new unlocks by recency,
   * and to tell a fresh completion apart from a record earned before the app
   * was installed (which has none).
   *
   * Not shown to the user: on an album played start to finish the completing
   * track is always the last track, so naming it looks like an insight while
   * carrying no information.
   */
  completedBy?: PlayEvent;
}

export type UnlockMode = 'new' | 'welcome';

export interface UnlockBatch {
  mode: UnlockMode;
  items: Unlock[];
}

interface SeenState {
  /** Album ids already celebrated, so a popup never repeats. */
  ids: string[];
  /** Set on first run, so an existing shelf is not celebrated retroactively. */
  initialised: boolean;
}

interface Storage {
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
}

const EMPTY: SeenState = { ids: [], initialised: false };

async function loadSeen(storage: Storage): Promise<SeenState> {
  try {
    const raw = await storage.read(SEEN_FILE);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<SeenState>;
    return {
      ids: Array.isArray(parsed.ids) ? parsed.ids : [],
      initialised: Boolean(parsed.initialised),
    };
  } catch {
    // A corrupt or unreadable seen-set must not break launch. Worst case we
    // re-celebrate something, which is a far better failure than a crash.
    return { ...EMPTY };
  }
}

async function saveSeen(storage: Storage, state: SeenState): Promise<void> {
  try {
    await storage.write(SEEN_FILE, JSON.stringify(state));
  } catch {
    // Non-fatal for the same reason.
  }
}

/** A play satisfies a missing track when artist and title both match. */
function satisfies(album: Album, missing: string, play: PlayEvent): boolean {
  return (
    matchKey(play.track) === matchKey(missing) &&
    artistKey(play.artist) === artistKey(album.artist)
  );
}

/**
 * Albums whose every missing track now has a play.
 *
 * Pure, so it can be tested without storage or a device.
 */
export function newlyCompleted(collection: Collection, plays: PlayEvent[]): Unlock[] {
  const unfinished = collection.albums.filter(
    (a) => !a.unlocked && a.missing_tracks.length > 0
  );
  if (unfinished.length === 0 || plays.length === 0) return [];

  const found: Unlock[] = [];
  for (const album of unfinished) {
    let last: PlayEvent | null = null;
    const all = album.missing_tracks.every((missing) => {
      // The EARLIEST play that satisfies this track, so `completedBy` is the
      // play that actually finished the album rather than the most recent one.
      let best: PlayEvent | null = null;
      for (const play of plays) {
        if (!satisfies(album, missing, play)) continue;
        if (!best || play.ts < best.ts) best = play;
      }
      if (!best) return false;
      if (!last || best.ts > last.ts) last = best;
      return true;
    });
    if (all && last) found.push({ album, completedBy: last });
  }
  // Most recently completed first: the last thing they finished is the one they
  // are most likely to remember doing.
  return found.sort((a, b) => (b.completedBy?.ts ?? 0) - (a.completedBy?.ts ?? 0));
}

/**
 * Albums the user appears to have played a lot of but which the collection has
 * never heard of. These cannot be completed on device -- no tracklist -- so they
 * are reported rather than silently dropped.
 */
export function pendingUnknownAlbums(
  collection: Collection,
  plays: PlayEvent[],
  minTracks = 5
): { artist: string; album: string; distinctTracks: number }[] {
  const known = new Set(
    collection.albums.map((a) => `${artistKey(a.artist)}::${matchKey(a.title)}`)
  );
  const groups = new Map<string, { artist: string; album: string; tracks: Set<string> }>();
  for (const play of plays) {
    if (!play.album) continue;
    const key = `${artistKey(play.artist)}::${matchKey(play.album)}`;
    if (known.has(key)) continue;
    const g = groups.get(key);
    if (g) g.tracks.add(matchKey(play.track));
    else
      groups.set(key, {
        artist: play.artist,
        album: play.album,
        tracks: new Set([matchKey(play.track)]),
      });
  }
  return [...groups.values()]
    .filter((g) => g.tracks.size >= minTracks)
    .map((g) => ({ artist: g.artist, album: g.album, distinctTracks: g.tracks.size }))
    .sort((a, b) => b.distinctTracks - a.distinctTracks);
}

/**
 * What to show on this launch.
 *
 * First run returns the shelf the user arrives with, as a `welcome` batch:
 * a history that already contains hundreds of finished records is the most
 * interesting thing about the app, and opening on an empty greeting wastes it.
 * It is a gallery to swipe, not a queue to acknowledge -- the caller is
 * expected to let the user leave at any point.
 *
 * Every run after that returns only genuinely new completions.
 */
export async function unlocksSinceLastVisit(
  collection: Collection,
  plays: PlayEvent[],
  storage: Storage
): Promise<UnlockBatch> {
  const seen = await loadSeen(storage);
  const completed = newlyCompleted(collection, plays);
  const earned = collection.albums.filter((a) => a.unlocked);

  if (!seen.initialised) {
    await saveSeen(storage, {
      ids: [...new Set([...earned.map((a) => a.id), ...completed.map((u) => u.album.id)])],
      initialised: true,
    });
    // Most-played first, so the records they care about come up while they are
    // still swiping. Anything freshly completed leads, since it is news.
    const freshIds = new Set(completed.map((u) => u.album.id));
    const history = earned
      .filter((a) => !freshIds.has(a.id))
      .sort((a, b) => b.play_count - a.play_count)
      .map((album) => ({ album }));
    return { mode: 'welcome', items: [...completed, ...history] };
  }

  const fresh = completed.filter((u) => !seen.ids.includes(u.album.id));
  if (fresh.length > 0) {
    await saveSeen(storage, {
      ids: [
        ...new Set([...seen.ids, ...earned.map((a) => a.id), ...fresh.map((u) => u.album.id)]),
      ],
      initialised: true,
    });
  }
  return { mode: 'new', items: fresh };
}

/** Test seam: forget everything celebrated so far. */
export async function resetSeen(storage: Storage): Promise<void> {
  await saveSeen(storage, { ...EMPTY });
}
