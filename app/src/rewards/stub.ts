/**
 * A fake backend for looking at the rewards UI before the Edge Functions exist.
 *
 * Development web builds only: add `?rewardsStub=<scenario>` to the URL.
 * It never touches the network and never sends email. Everything it shows is
 * labelled as sample data on screen, so it cannot be mistaken for the real
 * thing.
 *
 *   signedout   start signed out (sign-in "succeeds" with code 123456)
 *   empty       signed in, nothing linked, no stickers
 *   linked      signed in, Last.fm verified, stickers earned
 *
 * Extra knobs: `&lastfm=<reason>` makes the Last.fm link fail with that section-9
 * reason code (or `cancel`); `&syncFail=1` makes the third sync chunk fail;
 * `&art=<url>` gives every sample sticker that art, for checking the art path
 * before the reward-art bucket has anything in it.
 */

import type { RewardsApi } from './api';
import { RewardsError, type EarnedReward, type LinkedLastfm, type MilkUser } from './types';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BASE_SAMPLE: EarnedReward[] = [
  {
    key: 'r-blink:mbid-blink',
    rewardId: 'r-blink',
    kind: 'sticker',
    name: 'Blink Bunny',
    description: '182 plays of Blink-182.',
    artUrl: null,
    subjectKey: '',
    subjectName: null,
    subjectKind: null,
    grantedAt: '2026-09-18T20:14:00Z',
    evidence: { plays: 184, threshold: 182 },
  },
  {
    key: 'r-fan:mbid-radiohead',
    rewardId: 'r-fan',
    kind: 'sticker',
    name: 'Devoted Listener',
    description: '100 plays of one artist.',
    artUrl: null,
    subjectKey: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
    subjectName: 'Radiohead',
    subjectKind: 'artist',
    grantedAt: '2026-09-17T09:02:00Z',
    evidence: { plays: 312, threshold: 100 },
  },
  {
    key: 'r-fan:name:nujabes',
    rewardId: 'r-fan',
    kind: 'sticker',
    name: 'Devoted Listener',
    description: '100 plays of one artist.',
    artUrl: null,
    subjectKey: 'name:nujabes',
    subjectName: 'nujabes',
    subjectKind: 'artist',
    grantedAt: '2026-09-12T22:40:00Z',
    evidence: { plays: 141, threshold: 100 },
  },
];

export function makeStubApi(scenario: string, query: URLSearchParams): RewardsApi {
  const art = query.get('art');
  const SAMPLE = art ? BASE_SAMPLE.map((r) => ({ ...r, artUrl: art })) : BASE_SAMPLE;
  const listeners = new Set<(u: MilkUser | null) => void>();
  let user: MilkUser | null =
    scenario === 'signedout' ? null : { id: 'stub-user', email: 'you@example.com' };
  let linked: LinkedLastfm | null =
    scenario === 'linked'
      ? { username: 'sample_listener', verifiedAt: '2026-09-10T12:00:00Z', lastSyncedAt: '2026-09-18T20:14:00Z' }
      : null;
  let rewards: EarnedReward[] = scenario === 'linked' ? SAMPLE : [];
  let syncCalls = 0;

  const emit = () => listeners.forEach((cb) => cb(user));

  return {
    configured: true,
    stub: true,
    async currentUser() {
      return user;
    },
    onUserChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async sendEmailSignIn(email) {
      await wait(500);
      if (!/@/.test(email)) throw new RewardsError('That does not look like an email address.');
    },
    async verifyEmailCode(email, code) {
      await wait(400);
      if (code !== '123456') throw new RewardsError("That code didn't work. It may have expired; request a new one.");
      user = { id: 'stub-user', email };
      emit();
    },
    async completeEmailLink() {
      return false;
    },
    async signOut() {
      user = null;
      linked = null;
      rewards = [];
      emit();
    },
    async linkLastfm() {
      await wait(700);
      const forced = query.get('lastfm');
      if (forced === 'cancel') return { status: 'cancelled' };
      if (forced) return { status: 'error', reason: forced };
      linked = { username: 'sample_listener', verifiedAt: new Date().toISOString(), lastSyncedAt: null };
      return { status: 'ok' };
    },
    async syncLastfmStep() {
      await wait(450);
      syncCalls += 1;
      if (query.get('syncFail') && syncCalls === 3) {
        throw new RewardsError("Couldn't reach Milk's server for syncing last.fm. Check your connection and try again.", true);
      }
      const done = syncCalls % 6 === 0;
      if (done) {
        rewards = SAMPLE;
        if (linked) linked = { ...linked, lastSyncedAt: new Date().toISOString() };
      }
      return { done, pages_processed: 4, plays_added: 800 + syncCalls * 7, granted: done ? SAMPLE.length : 0 };
    },
    async linkedLastfm() {
      return linked;
    },
    async myRewards() {
      await wait(250);
      return rewards;
    },
  };
}
