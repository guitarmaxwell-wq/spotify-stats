// DEMO backend and MOCK rule functions.
//
// Neither touches Supabase. The demo backend is an in-memory catalog with a fake
// admin; the mock functions invent a listener population so the dry-run UI can
// be built and checked before `rules-dry-run` / `rules-evaluate` exist. Every
// number they produce is synthetic, and the UI labels it so.

import { ruleTypeDef, WILDCARD } from '../ruleTypes';
import type { Album, Artist, DryRunResult, DryRunRule, Reward, RewardDraft, Rule, RuleDraft, Session } from '../types';
import type { Backend, RuleFunctions } from './types';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();

// ------------------------------------------------------------ demo catalog --

const ARTISTS: Artist[] = [
  ['0743b15a-3c32-48c8-ad58-cb325350befa', 'Blink-182'],
  ['f2eef649-a6d5-4114-afba-e50ab26254d2', 'Sum 41'],
  ['a74b1b7f-71a5-4011-9441-d0b5e4122711', 'Radiohead'],
  ['name:nujabes', 'Nujabes'],
  ['b95ce3ff-3d05-4e87-9e01-c97b66af13d4', 'Eminem'],
  ['83d91898-7763-47d7-b03b-b92132375c47', 'Pink Floyd'],
  ['9c9f1380-2516-4fc9-a3e6-f9f61941d090', 'Muse'],
  ['name:mfdoom', 'MF DOOM'],
  ['cc197bad-dc9c-440d-a5b5-d52ba2e14234', 'Coldplay'],
  ['name:greenday', 'Green Day'],
].map(([mbid, name], i) => ({ id: `artist-${i}`, mbid, name }));

const ALBUMS: Album[] = [
  ['de0a1b00-0000-4000-8000-000000000001', 'Enema of the State', 0, 12],
  ['de0a1b00-0000-4000-8000-000000000002', 'OK Computer', 2, 12],
  ['de0a1b00-0000-4000-8000-000000000003', 'Kid A', 2, 10],
  ['de0a1b00-0000-4000-8000-000000000004', 'Modal Soul', 3, 14],
  ['de0a1b00-0000-4000-8000-000000000005', 'The Dark Side of the Moon', 5, 10],
  ['de0a1b00-0000-4000-8000-000000000006', 'The Marshall Mathers LP', 4, 18],
].map(([mbid, title, a, n], i) => ({
  id: `album-${i}`,
  release_mbid: mbid as string,
  title: title as string,
  artist_id: ARTISTS[a as number].id,
  artist_name: ARTISTS[a as number].name,
  track_count: n as number,
}));

function placeholderArt(label: string, seed: string): string {
  const h = hash(seed) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="18" fill="hsl(${h},40%,32%)"/><circle cx="60" cy="52" r="30" fill="hsl(${(h + 40) % 360},60%,62%)"/><text x="60" y="104" font-family="sans-serif" font-size="13" font-weight="700" text-anchor="middle" fill="#f4ece0">${label}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function seedRewards(): Reward[] {
  const r = (id: string, kind: Reward['kind'], name: string, description: string, subject_kind: Reward['subject_kind'], artist_id: string | null, art: boolean): Reward => ({
    id,
    kind,
    name,
    description,
    art_url: art ? placeholderArt(name.split(' ')[0].slice(0, 10), id) : null,
    subject_kind,
    artist_id,
    album_id: null,
    created_at: daysAgo(10),
  });
  return [
    r('rw-bunny', 'sticker', 'blink-bunny', 'The bunny, for 182 plays of Blink-182.', 'artist', ARTISTS[0].id, true),
    r('rw-skull', 'sticker', 'sum41-skull', 'For 41 plays of Sum 41.', 'artist', ARTISTS[1].id, true),
    r('rw-community', 'community', 'Artist community', 'Access to the artist community. Template: one per artist.', 'artist', null, true),
    r('rw-poster', 'poster', 'Album poster', 'A poster of the album. Template: one per album.', 'album', null, true),
    r('rw-fan-sticker', 'sticker', 'Fan sticker', 'A sticker in the artist colours. Template: one per artist.', 'artist', null, false),
    r('rw-crate-digger', 'sticker', 'Crate digger', 'For unlocking 50 albums.', null, null, true),
  ];
}

function seedRules(adminId: string): Rule[] {
  const r = (id: string, type: Rule['type'], params: Rule['params'], reward_id: string, active: boolean, d: number, notes: string | null): Rule => ({
    id,
    type,
    params,
    reward_id,
    active,
    starts_at: null,
    ends_at: null,
    notes,
    updated_by: adminId,
    updated_at: daysAgo(d),
    created_at: daysAgo(d + 3),
  });
  return [
    r('rule-sum41', 'artist_plays', { artist: ARTISTS[1].mbid, threshold: 41 }, 'rw-skull', true, 5, null),
    r('rule-community', 'artist_plays', { artist: WILDCARD, threshold: 100 }, 'rw-community', true, 1, 'Community access per artist.'),
    r('rule-poster', 'album_passes', { album: WILDCARD, threshold: 5 }, 'rw-poster', false, 7, 'Milestone 1b: waits for the album catalog.'),
  ];
}

// ------------------------------------------------------------- demo backend --

const DEMO_ADMIN: Session = { userId: '00000000-0000-4000-8000-0000000000ad', email: 'demo-admin@example.invalid' };

export type DemoStart = 'admin' | 'notadmin' | 'signedout';

export function createDemoBackend(start: DemoStart): Backend {
  const DEMO_USER: Session = { userId: '11111111-2222-4333-8444-555555555555', email: 'demo-listener@example.invalid' };
  let session: Session | null = start === 'signedout' ? null : start === 'notadmin' ? DEMO_USER : DEMO_ADMIN;
  const admin = start !== 'notadmin';
  const listeners = new Set<(s: Session | null) => void>();
  const artists = [...ARTISTS];
  const albums = [...ALBUMS];
  const rewards = seedRewards();
  const rules = seedRules(DEMO_ADMIN.userId);
  const setSession = (s: Session | null) => {
    session = s;
    listeners.forEach((l) => l(s));
  };
  const delay = <T,>(v: T, ms = 120) => new Promise<T>((res) => setTimeout(() => res(structuredClone(v)), ms));

  return {
    mode: 'demo',
    getSession: () => delay(session, 0),
    onAuthChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async signInWithPassword(email) {
      setSession({ userId: admin ? DEMO_ADMIN.userId : DEMO_USER.userId, email });
    },
    async sendMagicLink() {
      /* demo: nothing is sent */
    },
    async signOut() {
      setSession(null);
    },
    isAdmin: () => delay(admin),

    listRules: () => delay(rules),
    async createRule(d: RuleDraft, by) {
      const rule: Rule = { ...structuredClone(d), id: uuid(), updated_by: by, updated_at: now(), created_at: now() };
      rules.unshift(rule);
      return delay(rule);
    },
    async updateRule(id, d, by) {
      const i = rules.findIndex((r) => r.id === id);
      if (i < 0) throw new Error('No such rule.');
      rules[i] = { ...rules[i], ...structuredClone(d), updated_by: by, updated_at: now() };
      return delay(rules[i]);
    },

    listRewards: () => delay(rewards),
    async createReward(d: RewardDraft) {
      const reward: Reward = { ...d, id: uuid(), created_at: now() };
      rewards.unshift(reward);
      return delay(reward);
    },
    async updateReward(id, d) {
      const i = rewards.findIndex((r) => r.id === id);
      rewards[i] = { ...rewards[i], ...d };
      return delay(rewards[i]);
    },
    async uploadArt(file) {
      // Demo: keep the image in the page instead of Storage.
      return await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(file);
      });
    },

    searchArtists: (q) => delay(artists.filter((a) => a.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8)),
    searchAlbums: (q) => delay(albums.filter((a) => a.title.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8)),
    artistsByMbid: (keys) => delay(artists.filter((a) => keys.includes(a.mbid)), 0),
    artistsById: (ids) => delay(artists.filter((a) => ids.includes(a.id)), 0),
    albumsByMbid: (keys) => delay(albums.filter((a) => keys.includes(a.release_mbid)), 0),
    albumsById: (ids) => delay(albums.filter((a) => ids.includes(a.id)), 0),
    async ensureArtist(mbid, name) {
      let a = artists.find((x) => x.mbid === mbid);
      if (!a) {
        a = { id: uuid(), mbid, name };
        artists.push(a);
      }
      return delay(a, 0);
    },
    catalogSample: async (kind, limit) =>
      kind === 'artist'
        ? artists.slice(0, limit).map((a) => ({ key: a.mbid, name: a.name }))
        : albums.slice(0, limit).map((a) => ({ key: a.release_mbid, name: a.title })),
  };
}

// ---------------------------------------------------------- mock functions --

const POPULATION = 640;

/** How many of the synthetic listeners qualify for one subject. */
function qualifying(type: Rule['type'], subject: string, threshold: number): number {
  const h = hash(subject);
  const fans = 8 + (h % 70);
  const scale = 40 + ((h >> 8) % 260);
  const t = Math.max(threshold, 1);
  switch (type) {
    case 'artist_plays':
      return Math.round(fans * Math.exp(-t / scale));
    case 'album_unlocked':
      return Math.round(fans * 0.3);
    case 'album_passes':
      return Math.round(fans * 0.3 * Math.exp(-(t - 1) / 4));
    case 'artist_albums_unlocked':
      return Math.round(fans * 0.45 * Math.exp(-(t - 1) / 2));
    case 'albums_unlocked':
      return Math.round(POPULATION * Math.exp(-t / 45));
  }
}

/**
 * Mock `rules-dry-run` / `rules-evaluate`. Keeps a pretend grant ledger per
 * (reward, subject) so that saving a rule and then loosening it shows "N new",
 * and tightening it shows 0 new: the same shape the real functions must return.
 */
export function createMockFunctions(backend: Backend): RuleFunctions {
  const ledger: Map<string, number> = ((globalThis as { __milkLedger?: Map<string, number> }).__milkLedger ??= new Map());
  const FALLBACK = ARTISTS.map((a) => ({ key: a.mbid, name: a.name }));
  const FALLBACK_ALBUMS = ALBUMS.map((a) => ({ key: a.release_mbid, name: a.title }));

  async function subjectsFor(rule: DryRunRule): Promise<{ key: string; name: string }[]> {
    const def = ruleTypeDef(rule.type);
    if (!def.target) return [{ key: '', name: '(all albums)' }];
    const target = def.target === 'artist' ? rule.params.artist! : rule.params.album!;
    if (target !== WILDCARD) {
      const named =
        def.target === 'artist'
          ? (await backend.artistsByMbid([target]))[0]?.name
          : (await backend.albumsByMbid([target]))[0]?.title;
      return [{ key: target, name: named ?? target }];
    }
    const sample = await backend.catalogSample(def.target, 200);
    if (sample.length) return sample;
    return def.target === 'artist' ? FALLBACK : FALLBACK_ALBUMS;
  }

  async function compute(rule: DryRunRule) {
    const subjects = await subjectsFor(rule);
    const t = rule.params.threshold ?? 1;
    return subjects
      .map((s) => {
        const users = qualifying(rule.type, s.key, t);
        const already = Math.min(users, ledger.get(`${rule.reward_id}|${s.key}`) ?? 0);
        return { ...s, users, already };
      })
      .filter((s) => s.users > 0);
  }

  const fns: RuleFunctions = {
    mode: 'mock',
    async dryRun(rule): Promise<DryRunResult> {
      await new Promise((r) => setTimeout(r, 450));
      const rows = await compute(rule);
      // Grants are (user, subject) pairs; users are people. One user can qualify
      // for many artists, so the two are counted separately (section 9).
      const grants = rows.reduce((n, r) => n + r.users, 0);
      const already = rows.reduce((n, r) => n + r.already, 0);
      const missAll = rows.reduce((p, r) => p * (1 - r.users / POPULATION), 1);
      const users = rows.length ? Math.max(1, Math.round(POPULATION * (1 - missAll))) : 0;
      return {
        qualifying_users: users,
        new_grants: grants - already,
        already_granted: already,
        subjects: rows.length,
        sample: [...rows]
          .sort((a, b) => b.users - a.users)
          .slice(0, 10)
          .map((r) => ({ subject_key: r.key, subject_name: r.key === '' ? null : r.name, users: r.users })),
      };
    },
    async evaluate({ rule_id }) {
      await new Promise((r) => setTimeout(r, 450));
      const rules = (await backend.listRules()).filter((r) => r.active && (!rule_id || r.id === rule_id));
      let granted = 0;
      for (const rule of rules) {
        for (const row of await compute(rule)) {
          const k = `${rule.reward_id}|${row.key}`;
          const had = ledger.get(k) ?? 0;
          if (row.users > had) {
            granted += row.users - had;
            ledger.set(k, row.users); // never lowered: grants are never revoked
          }
        }
      }
      return { evaluated_users: POPULATION, granted, skipped_rules: [] };
    },
  };
  return fns;
}

/** Pretend the seeded demo rules were evaluated long ago, so dry runs show "already granted". */
export async function seedLedger(fns: RuleFunctions) {
  const g = globalThis as { __milkSeeded?: boolean };
  if (g.__milkSeeded) return;
  g.__milkSeeded = true;
  await fns.evaluate({});
}
