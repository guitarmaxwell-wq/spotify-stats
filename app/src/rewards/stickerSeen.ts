/**
 * Which sticker grants have already been celebrated, per Milk user, so the
 * popup never repeats -- the same idea as the album seen-set in
 * `link/unlockWatch.ts`, stored beside it.
 *
 * This is a UI nicety, not a record of anything: grants themselves live on the
 * server. If the file is lost, the worst case is one repeated celebration.
 */

import { PlayStore } from '../link/playStore';
import type { EarnedReward } from './types';

const FILE = 'stickers-seen.v1.json';

type SeenFile = Record<string, { keys: string[] }>;

export type StickerMode = 'welcome' | 'new';

export interface StickerBatch {
  mode: StickerMode;
  items: EarnedReward[];
}

// Only the storage is needed; constructing a PlayStore does not read plays.
const storage = () => new PlayStore().storage;

async function load(): Promise<SeenFile> {
  try {
    const raw = await storage().read(FILE);
    const parsed = raw ? (JSON.parse(raw) as SeenFile) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Grants this user has not been shown yet, and marks them shown.
 *
 * The first time a user is seen on this device, everything they hold arrives
 * as a `welcome` batch: after a first Last.fm backfill that can be several
 * stickers at once, and each one is genuinely new to them.
 */
export async function unseenStickers(userId: string, earned: EarnedReward[]): Promise<StickerBatch> {
  const stickers = earned.filter((r) => r.kind === 'sticker');
  const all = await load();
  const mine = all[userId];
  const seen = new Set(mine?.keys ?? []);
  const fresh = stickers.filter((r) => !seen.has(r.key));
  if (fresh.length > 0 || !mine) {
    all[userId] = { keys: [...new Set([...seen, ...stickers.map((r) => r.key)])] };
    try {
      await storage().write(FILE, JSON.stringify(all));
    } catch {
      /* non-fatal: see the note above */
    }
  }
  return { mode: mine ? 'new' : 'welcome', items: fresh };
}
