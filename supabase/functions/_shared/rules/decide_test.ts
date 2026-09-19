// Pure decision logic: no database. Run: deno test supabase/functions/_shared/rules/

import { assertEquals } from "jsr:@std/assert@1";
import { albumPasses, decideGrants, isLive, qualify } from "./decide.ts";
import type { AlbumAggregate, ParsedParams, ParsedRule, UserAggregates } from "./types.ts";

const U = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-19T12:00:00Z");
const BLINK = "0743b15a-3c32-48c8-ad58-cb325350befa";
const RADIOHEAD = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const NUJABES = "name:nujabes";
const OKC = "b1392450-e666-3926-a536-22c65f834433";
const KID_A = "c8f5b3a6-0b6d-4c69-9f15-6e0ecb0d7e1a";
const MODAL = "d0000000-0000-4000-8000-000000000001";

function album(key: string, artistKey: string | null, tracklist: string[], plays: Record<string, number>): AlbumAggregate {
  return { key, artistKey, tracklist, trackPlays: new Map(Object.entries(plays)) };
}

function agg(artists: Record<string, number>, albums: AlbumAggregate[] = []): UserAggregates {
  return { artistPlays: new Map(Object.entries(artists)), albums };
}

let n = 0;
function rule(params: ParsedParams, extra: Partial<ParsedRule> = {}): ParsedRule {
  return { id: `rule-${++n}`, reward_id: `reward-${n}`, params, active: true, starts_at: null, ends_at: null, ...extra };
}

// ------------------------------------------------------------ albumPasses --

Deno.test("albumPasses: minimum play count across tracks", () => {
  assertEquals(albumPasses(["a", "b", "c"], new Map([["a", 9], ["b", 5], ["c", 7]])), 5);
});

Deno.test("albumPasses: one unplayed track means 0 passes", () => {
  assertEquals(albumPasses(["a", "b", "c"], new Map([["a", 90], ["b", 50]])), 0);
});

Deno.test("albumPasses: replaying only the single does not count", () => {
  assertEquals(albumPasses(["single", "b"], new Map([["single", 1000], ["b", 1]])), 1);
});

Deno.test("albumPasses: plays of tracks NOT on the tracklist are ignored", () => {
  assertEquals(albumPasses(["a"], new Map([["a", 2], ["bonus", 99]])), 2);
});

Deno.test("albumPasses: duplicate tracklist keys count once", () => {
  assertEquals(albumPasses(["a", "a", "b"], new Map([["a", 3], ["b", 4]])), 3);
});

Deno.test("albumPasses: empty tracklist is 0, never a free unlock", () => {
  assertEquals(albumPasses([], new Map([["a", 5]])), 0);
});

// ------------------------------------------------------------- artist_plays --

Deno.test("artist_plays: specific artist at exactly the threshold qualifies, keyed by that artist", () => {
  assertEquals(qualify({ type: "artist_plays", artist: BLINK, threshold: 182 }, agg({ [BLINK]: 182 })), [
    { subject_key: BLINK, evidence: { type: "artist_plays", plays: 182, threshold: 182 } },
  ]);
});

Deno.test("artist_plays: one below the threshold does not", () => {
  assertEquals(qualify({ type: "artist_plays", artist: BLINK, threshold: 182 }, agg({ [BLINK]: 181 })), []);
});

Deno.test("artist_plays: specific artist ignores other artists' plays", () => {
  assertEquals(qualify({ type: "artist_plays", artist: BLINK, threshold: 1 }, agg({ [RADIOHEAD]: 500 })), []);
});

Deno.test("artist_plays: wildcard grants per qualifying artist, including name: keys", () => {
  const q = qualify({ type: "artist_plays", artist: "*", threshold: 100 }, agg({ [RADIOHEAD]: 150, [NUJABES]: 100, [BLINK]: 99 }));
  assertEquals(q.map((x) => x.subject_key).sort(), [NUJABES, RADIOHEAD].sort());
  assertEquals(q.find((x) => x.subject_key === RADIOHEAD)!.evidence, { type: "artist_plays", plays: 150, threshold: 100 });
});

Deno.test("artist_plays: a synthetic name: key can be targeted directly", () => {
  assertEquals(qualify({ type: "artist_plays", artist: NUJABES, threshold: 50 }, agg({ [NUJABES]: 60 })).length, 1);
});

// --------------------------------------------------- album_unlocked/passes --

const okc = (plays: Record<string, number>) => album(OKC, RADIOHEAD, ["airbag", "paranoid android", "karma police"], plays);

Deno.test("album_unlocked: every track at least once", () => {
  assertEquals(qualify({ type: "album_unlocked", album: OKC }, agg({}, [okc({ airbag: 1, "paranoid android": 3, "karma police": 1 })])), [
    { subject_key: OKC, evidence: { type: "album_unlocked", passes: 1, tracks: 3 } },
  ]);
});

Deno.test("album_unlocked: an unplayed track blocks the unlock", () => {
  assertEquals(qualify({ type: "album_unlocked", album: OKC }, agg({}, [okc({ airbag: 10, "karma police": 10 })])), []);
});

Deno.test("album_unlocked: wildcard grants per unlocked album", () => {
  const albums = [
    okc({ airbag: 1, "paranoid android": 1, "karma police": 1 }),
    album(KID_A, RADIOHEAD, ["everything", "kid a"], { everything: 2 }),
    album(MODAL, NUJABES, ["feather"], { feather: 4 }),
  ];
  assertEquals(qualify({ type: "album_unlocked", album: "*" }, agg({}, albums)).map((q) => q.subject_key).sort(), [MODAL, OKC].sort());
});

Deno.test("album_passes: min across tracks vs threshold, with evidence", () => {
  const a = okc({ airbag: 7, "paranoid android": 5, "karma police": 6 });
  assertEquals(qualify({ type: "album_passes", album: OKC, threshold: 5 }, agg({}, [a])), [
    { subject_key: OKC, evidence: { type: "album_passes", passes: 5, threshold: 5, tracks: 3 } },
  ]);
  assertEquals(qualify({ type: "album_passes", album: OKC, threshold: 6 }, agg({}, [a])), []);
});

Deno.test("album_passes: album with an unplayed track has 0 passes, never qualifies", () => {
  const a = okc({ airbag: 99, "paranoid android": 99 });
  assertEquals(qualify({ type: "album_passes", album: "*", threshold: 1 }, agg({}, [a])), []);
});

Deno.test("album_passes: wildcard keyed per album", () => {
  const albums = [
    okc({ airbag: 5, "paranoid android": 5, "karma police": 5 }),
    album(MODAL, NUJABES, ["feather", "reflection eternal"], { feather: 5, "reflection eternal": 4 }),
  ];
  assertEquals(qualify({ type: "album_passes", album: "*", threshold: 5 }, agg({}, albums)).map((q) => q.subject_key), [OKC]);
});

// ------------------------------------------- artist_albums_unlocked / total --

const discography = [
  okc({ airbag: 1, "paranoid android": 1, "karma police": 1 }), // unlocked
  album(KID_A, RADIOHEAD, ["everything", "kid a"], { everything: 1, "kid a": 1 }), // unlocked
  album("e0000000-0000-4000-8000-000000000001", RADIOHEAD, ["x", "y"], { x: 5 }), // not unlocked
  album(MODAL, NUJABES, ["feather"], { feather: 1 }), // unlocked
  album("f0000000-0000-4000-8000-000000000001", null, ["z"], { z: 3 }), // unlocked, no artist
];

Deno.test("artist_albums_unlocked: counts only that artist's UNLOCKED albums", () => {
  assertEquals(qualify({ type: "artist_albums_unlocked", artist: RADIOHEAD, threshold: 2 }, agg({}, discography)), [
    { subject_key: RADIOHEAD, evidence: { type: "artist_albums_unlocked", albums_unlocked: 2, threshold: 2 } },
  ]);
  assertEquals(qualify({ type: "artist_albums_unlocked", artist: RADIOHEAD, threshold: 3 }, agg({}, discography)), []);
});

Deno.test("artist_albums_unlocked: wildcard per artist; albums without an artist count for nobody", () => {
  const q = qualify({ type: "artist_albums_unlocked", artist: "*", threshold: 1 }, agg({}, discography));
  assertEquals(q.map((x) => x.subject_key).sort(), [NUJABES, RADIOHEAD].sort());
});

Deno.test("albums_unlocked: total across artists (incl. artistless), subject ''", () => {
  assertEquals(qualify({ type: "albums_unlocked", threshold: 4 }, agg({}, discography)), [
    { subject_key: "", evidence: { type: "albums_unlocked", albums_unlocked: 4, threshold: 4 } },
  ]);
  assertEquals(qualify({ type: "albums_unlocked", threshold: 5 }, agg({}, discography)), []);
});

Deno.test("album types with no album data qualify nothing", () => {
  const empty = agg({ [RADIOHEAD]: 1000 });
  assertEquals(qualify({ type: "album_unlocked", album: "*" }, empty), []);
  assertEquals(qualify({ type: "albums_unlocked", threshold: 1 }, empty), []);
  assertEquals(qualify({ type: "artist_albums_unlocked", artist: "*", threshold: 1 }, empty), []);
});

// ------------------------------------------------------------ date window --

Deno.test("isLive: active flag", () => {
  assertEquals(isLive({ active: true, starts_at: null, ends_at: null }, NOW), true);
  assertEquals(isLive({ active: false, starts_at: null, ends_at: null }, NOW), false);
});

Deno.test("isLive: window is judged at evaluation time, [starts_at, ends_at)", () => {
  const w = (s: string | null, e: string | null) => isLive({ active: true, starts_at: s, ends_at: e }, NOW);
  assertEquals(w("2026-09-19T12:00:00Z", null), true); // starts exactly now
  assertEquals(w("2026-09-19T12:00:01Z", null), false); // not yet
  assertEquals(w(null, "2026-09-19T12:00:00Z"), false); // ends exactly now: exclusive
  assertEquals(w(null, "2026-09-19T12:00:01Z"), true);
  assertEquals(w("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z"), true);
  assertEquals(w("2025-01-01T00:00:00Z", "2025-12-31T00:00:00Z"), false); // passed
});

// ----------------------------------------------------------- decideGrants --

Deno.test("decideGrants: maps qualifications to user_rewards rows", () => {
  const r = rule({ type: "artist_plays", artist: BLINK, threshold: 182 });
  assertEquals(decideGrants(U, [r], agg({ [BLINK]: 184 }), NOW), [
    { user_id: U, reward_id: r.reward_id, subject_key: BLINK, rule_id: r.id, evidence: { type: "artist_plays", plays: 184, threshold: 182 } },
  ]);
});

Deno.test("decideGrants: inactive, not-yet-started and ended rules grant nothing", () => {
  const a = agg({ [BLINK]: 1000 });
  const p: ParsedParams = { type: "artist_plays", artist: BLINK, threshold: 1 };
  assertEquals(decideGrants(U, [rule(p, { active: false })], a, NOW), []);
  assertEquals(decideGrants(U, [rule(p, { starts_at: "2027-01-01T00:00:00Z" })], a, NOW), []);
  assertEquals(decideGrants(U, [rule(p, { ends_at: "2026-01-01T00:00:00Z" })], a, NOW), []);
});

Deno.test("decideGrants: two rules granting the same (reward, subject) yield one grant, first rule wins", () => {
  const r1 = rule({ type: "artist_plays", artist: "*", threshold: 100 });
  const r2 = { ...rule({ type: "artist_plays", artist: RADIOHEAD, threshold: 50 }), reward_id: r1.reward_id };
  const g = decideGrants(U, [r1, r2], agg({ [RADIOHEAD]: 150 }), NOW);
  assertEquals(g.length, 1);
  assertEquals(g[0].rule_id, r1.id);
});

Deno.test("decideGrants: same subject, different rewards are separate grants", () => {
  const g = decideGrants(U, [
    rule({ type: "artist_plays", artist: RADIOHEAD, threshold: 10 }),
    rule({ type: "artist_plays", artist: "*", threshold: 100 }),
  ], agg({ [RADIOHEAD]: 150 }), NOW);
  assertEquals(g.length, 2);
});

Deno.test("decideGrants: deterministic and pure (same input, same output, input untouched)", () => {
  const rules = [rule({ type: "album_passes", album: "*", threshold: 1 }), rule({ type: "albums_unlocked", threshold: 1 })];
  const a = agg({}, discography);
  const before = JSON.stringify([...a.artistPlays], null) + discography.length;
  assertEquals(decideGrants(U, rules, a, NOW), decideGrants(U, rules, a, NOW));
  assertEquals(JSON.stringify([...a.artistPlays], null) + discography.length, before);
});
