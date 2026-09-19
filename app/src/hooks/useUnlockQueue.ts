/**
 * Works out what to show on launch, and hands it to the UI.
 *
 * Failure here must never block the shelf: if the play store cannot be read, or
 * the seen-set is corrupt, the app opens normally with nothing to show.
 * A missed celebration is a disappointment; a launch crash is a broken app.
 */

import { useCallback, useEffect, useState } from 'react';

import { loadCollection } from '../data/collection';
import { PlayStore } from '../link/playStore';
import { unlocksSinceLastVisit, type UnlockBatch } from '../link/unlockWatch';

/** Only plays from roughly the last month can complete something on return. */
const WINDOW_S = 60 * 60 * 24 * 45;

export function useUnlockQueue() {
  const [batch, setBatch] = useState<UnlockBatch | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await new PlayStore().load();
        const since = Math.floor(Date.now() / 1000) - WINDOW_S;
        const recent = store.events.filter((p) => p.ts >= since);
        // Note: no early return on an empty play store. The first run has
        // nothing recent by definition, and that is exactly the run that shows
        // the welcome gallery of the shelf they arrived with.
        const found = await unlocksSinceLastVisit(loadCollection(), recent, store.storage);
        if (!cancelled && found.items.length > 0) setBatch(found);
      } catch {
        // Intentionally silent: see the note at the top of this file.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const close = useCallback(() => setBatch(null), []);

  return { batch, close, showing: Boolean(batch && batch.items.length > 0) };
}
