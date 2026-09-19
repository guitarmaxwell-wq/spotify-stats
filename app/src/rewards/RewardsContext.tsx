/**
 * App-wide rewards state: who is signed in, their verified Last.fm link, their
 * earned stickers, the Last.fm sync loop, and the queue of stickers waiting to
 * be celebrated.
 *
 * The sync loop lives here rather than in LinkScreen so that leaving the screen
 * mid-backfill does not abandon it. A first backfill can take many calls.
 *
 * Signed out, this provider does nothing at all: no requests, no timers.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Linking } from 'react-native';

import { rewardsApi } from './client';
import { unseenStickers, type StickerBatch } from './stickerSeen';
import {
  RewardsError,
  type EarnedReward,
  type LinkedLastfm,
  type MilkUser,
  type SyncProgress,
} from './types';

/** A runaway guard. Section 9 promises `done`, but a server bug must not loop forever. */
const MAX_SYNC_CALLS = 1000;
/** `lastfm-sync` answers `busy` when another sync holds the account's lock. */
const BUSY_WAIT_MS = 3000;
const MAX_BUSY_WAITS = 20;

interface RewardsState {
  configured: boolean;
  stub: boolean;
  /** False until the stored session has been read (local only, no network). */
  ready: boolean;
  user: MilkUser | null;
  linked: LinkedLastfm | null;
  rewards: EarnedReward[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;

  sync: SyncProgress | null;
  syncing: boolean;
  syncError: string | null;
  startSync: () => void;

  /** Set when an email sign-in link failed to complete. */
  linkError: string | null;

  stickerBatch: StickerBatch | null;
  closeStickers: () => void;
}

const Ctx = createContext<RewardsState | null>(null);

export function useRewards(): RewardsState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRewards must be used inside <RewardsProvider>');
  return v;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function RewardsProvider({ children }: { children: React.ReactNode }) {
  const api = rewardsApi;
  const [ready, setReady] = useState(!api.configured);
  const [user, setUser] = useState<MilkUser | null>(null);
  const [linked, setLinked] = useState<LinkedLastfm | null>(null);
  const [rewards, setRewards] = useState<EarnedReward[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncProgress | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [stickerBatch, setStickerBatch] = useState<StickerBatch | null>(null);

  const userRef = useRef<MilkUser | null>(null);
  userRef.current = user;
  const syncingRef = useRef(false);

  // ------------------------------------------------------------- session --
  useEffect(() => {
    if (!api.configured) return;
    let alive = true;
    api
      .currentUser()
      .then((u) => alive && setUser(u))
      .catch(() => {})
      .finally(() => alive && setReady(true));
    const off = api.onUserChange((u) => {
      if (!alive) return;
      setUser((prev) => (prev?.id === u?.id ? prev : u));
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  // Email sign-in links arrive as milk://auth/callback?code=...
  useEffect(() => {
    if (!api.configured) return;
    const handle = (url: string | null) => {
      if (!url) return;
      api.completeEmailLink(url).then(
        (handled) => handled && setLinkError(null),
        (e) => setLinkError(message(e)),
      );
    };
    Linking.getInitialURL().then(handle, () => {});
    const sub = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => sub.remove();
  }, [api]);

  // -------------------------------------------------------------- reads --
  const refresh = useCallback(async () => {
    const u = userRef.current;
    if (!u) return;
    setLoading(true);
    setError(null);
    try {
      const [acct, earned] = await Promise.all([api.linkedLastfm(), api.myRewards()]);
      if (userRef.current?.id !== u.id) return; // signed out meanwhile
      setLinked(acct);
      setRewards(earned);
      const batch = await unseenStickers(u.id, earned);
      if (batch.items.length > 0) setStickerBatch(batch);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    // Clear everything belonging to the previous user first, so one person's
    // stickers can never flash up on another's screen.
    setLinked(null);
    setRewards(null);
    setSync(null);
    setSyncError(null);
    setStickerBatch(null);
    if (user) refresh();
  }, [user, refresh]);

  // --------------------------------------------------------------- sync --
  const startSync = useCallback(() => {
    if (syncingRef.current || !userRef.current) return;
    const who = userRef.current.id;
    syncingRef.current = true;
    setSyncing(true);
    setSyncError(null);
    const progress: SyncProgress = { calls: 0, pages: 0, playsAdded: 0, granted: 0, done: false };
    setSync({ ...progress });
    let busyWaits = 0;
    (async () => {
      try {
        while (!progress.done) {
          if (userRef.current?.id !== who) return;
          if (progress.calls >= MAX_SYNC_CALLS) {
            throw new RewardsError('Sync stopped after an unusually long run. Tap Sync to carry on from where it left off.');
          }
          const step = await api.syncLastfmStep();
          if (step.busy) {
            // Another sync (another device, or a call still finishing server
            // side) holds this account's lock. Back off rather than hammer it.
            busyWaits += 1;
            if (busyWaits > MAX_BUSY_WAITS) {
              throw new RewardsError(
                'Another sync of your Last.fm is still running, maybe from another device. Try again in a few minutes.',
              );
            }
            setSync({ ...progress, waiting: true });
            await new Promise((r) => setTimeout(r, BUSY_WAIT_MS));
            continue;
          }
          busyWaits = 0;
          progress.calls += 1;
          progress.pages += step.pages_processed;
          progress.playsAdded += step.plays_added;
          progress.granted += step.granted;
          progress.done = step.done;
          setSync({ ...progress });
        }
      } catch (e) {
        // lastfm-sync is resumable (section 9), so a failure part-way loses
        // nothing: the next Sync continues from the server's cursor.
        setSyncError(message(e));
      } finally {
        syncingRef.current = false;
        setSyncing(false);
        if (userRef.current?.id === who) refresh();
      }
    })();
  }, [api, refresh]);

  const closeStickers = useCallback(() => setStickerBatch(null), []);

  const value = useMemo<RewardsState>(
    () => ({
      configured: api.configured,
      stub: api.stub,
      ready,
      user,
      linked,
      rewards,
      loading,
      error,
      refresh,
      sync,
      syncing,
      syncError,
      startSync,
      linkError,
      stickerBatch,
      closeStickers,
    }),
    [api, ready, user, linked, rewards, loading, error, refresh, sync, syncing, syncError, startSync, linkError, stickerBatch, closeStickers],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
