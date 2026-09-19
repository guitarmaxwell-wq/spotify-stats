// The load -> decide -> write path against an in-memory fake of supabase-js
// (fake_db.ts). Proves wiring, paging, idempotency, never-revoke and that the
// dry run never writes. Live behaviour of the real PostgREST queries is
// checked separately (see the report); this does not replace that.

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { evaluate, evaluateUser, RuleNotFoundError } from "./evaluate.ts";
import { dryRun } from "./dry_run.ts";
import { FakeDb } from "./fake_db.ts";
import { RuleValidationError } from "./validate.ts";

const RADIOHEAD = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const BLINK = "0743b15a-3c32-48c8-ad58-cb325350befa";
const NUJABES = "name:nujabes";
const OKC = "b1392450-e666-3926-a536-22c65f834433";
const MODAL = "d0000000-0000-4000-8000-000000000001";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function seed(maxRows = 1000) {
  const db = new FakeDb(maxRows);
  db.tables.artists = [
    { id: "art-rh", mbid: RADIOHEAD, name: "Radiohead" },
    { id: "art-bl", mbid: BLINK, name: "blink-182" },
    { id: "art-nu", mbid: NUJABES, name: "Nujabes" },
  ];
  db.tables.albums = [
    { id: "alb-okc", release_mbid: OKC, artist_id: "art-rh", title: "OK Computer", tracklist: ["airbag", "paranoid android", "karma police"] },
    { id: "alb-modal", release_mbid: MODAL, artist_id: "art-nu", title: "Modal Soul", tracklist: ["feather", "reflection eternal"] },
  ];
  db.tables.rewards = [
    { id: "rw-community", kind: "community", subject_kind: "artist", artist_id: null, album_id: null },
    { id: "rw-blink", kind: "sticker", subject_kind: null, artist_id: null, album_id: null },
    { id: "rw-poster", kind: "poster", subject_kind: "album", artist_id: null, album_id: null },
    { id: "rw-collector", kind: "sticker", subject_kind: null, artist_id: null, album_id: null },
  ];
  db.tables.rules = [];
  db.tables.profiles = [];
  db.tables.artist_plays = [];
  db.tables.track_plays = [];
  db.tables.user_rewards = [];
  return db;
}

let ruleN = 0;
function addRule(db: FakeDb, type: string, params: unknown, reward_id: string, extra: Record<string, unknown> = {}) {
  const id = `rule-${String(++ruleN).padStart(4, "0")}`;
  db.tables.rules.push({
    id, type, params, reward_id, active: true, starts_at: null, ends_at: null,
    created_at: `2026-09-19T00:00:${String(ruleN % 60).padStart(2, "0")}Z`, ...extra,
  });
  return id;
}

function addUser(db: FakeDb, n: number, artists: Record<string, number>, tracks: Record<string, Record<string, number>> = {}) {
  const id = uid(n);
  db.tables.profiles.push({ id });
  for (const [artistId, plays] of Object.entries(artists)) db.tables.artist_plays.push({ user_id: id, artist_id: artistId, plays });
  for (const [albumId, t] of Object.entries(tracks)) {
    for (const [track_key, plays] of Object.entries(t)) db.tables.track_plays.push({ user_id: id, album_id: albumId, track_key, plays });
  }
  return id;
}

const asDb = (db: FakeDb) => db as unknown as SupabaseClient;
const grantsOf = (db: FakeDb, user: string) =>
  db.tables.user_rewards.filter((g) => g.user_id === user).map((g) => `${g.reward_id}|${g.subject_key}`).sort();

Deno.test("evaluateUser: wildcard grants per artist, specific rule keyed by its artist, evidence recorded", async () => {
  const db = seed();
  const wild = addRule(db, "artist_plays", { artist: "*", threshold: 100 }, "rw-community");
  addRule(db, "artist_plays", { artist: BLINK, threshold: 182 }, "rw-blink");
  const u = addUser(db, 1, { "art-rh": 150, "art-nu": 100, "art-bl": 184 });

  assertEquals(await evaluateUser(asDb(db), u), { granted: 4 });
  assertEquals(grantsOf(db, u), [
    `rw-blink|${BLINK}`,
    `rw-community|${BLINK}`,
    `rw-community|${RADIOHEAD}`,
    `rw-community|${NUJABES}`,
  ].sort());
  const rh = db.tables.user_rewards.find((g) => g.subject_key === RADIOHEAD)!;
  assertEquals(rh.rule_id, wild);
  assertEquals(rh.evidence, { type: "artist_plays", plays: 150, threshold: 100 });
  const bl = db.tables.user_rewards.find((g) => g.reward_id === "rw-blink")!;
  assertEquals(bl.evidence, { type: "artist_plays", plays: 184, threshold: 182 });
});

Deno.test("idempotent: evaluating again grants nothing new and changes nothing", async () => {
  const db = seed();
  addRule(db, "artist_plays", { artist: "*", threshold: 100 }, "rw-community");
  const u = addUser(db, 1, { "art-rh": 150 });
  assertEquals(await evaluateUser(asDb(db), u), { granted: 1 });
  const snapshot = structuredClone(db.tables.user_rewards);
  for (let i = 0; i < 3; i++) assertEquals(await evaluateUser(asDb(db), u), { granted: 0 });
  assertEquals(db.tables.user_rewards, snapshot);
});

Deno.test("never revoke: raising the threshold, deactivating or ending the window keeps grants", async () => {
  const db = seed();
  const r = addRule(db, "artist_plays", { artist: "*", threshold: 100 }, "rw-community");
  const u = addUser(db, 1, { "art-rh": 150 });
  await evaluateUser(asDb(db), u);
  const snapshot = structuredClone(db.tables.user_rewards);
  const rule = db.tables.rules.find((x) => x.id === r)!;

  rule.params = { artist: "*", threshold: 1000 };
  assertEquals(await evaluateUser(asDb(db), u), { granted: 0 });
  rule.active = false;
  assertEquals(await evaluateUser(asDb(db), u), { granted: 0 });
  rule.active = true;
  rule.ends_at = "2020-01-01T00:00:00Z";
  assertEquals(await evaluate(asDb(db)), { evaluated_users: 0, granted: 0, skipped_rules: [] });
  assertEquals(db.tables.user_rewards, snapshot);
});

Deno.test("never overwrite: an existing grant's evidence and rule_id are untouched", async () => {
  const db = seed();
  addRule(db, "artist_plays", { artist: "*", threshold: 10 }, "rw-community");
  const u = addUser(db, 1, { "art-rh": 500 });
  db.tables.user_rewards.push({ user_id: u, reward_id: "rw-community", subject_key: RADIOHEAD, rule_id: "old", evidence: { plays: 1 } });
  assertEquals(await evaluateUser(asDb(db), u), { granted: 0 });
  assertEquals(db.tables.user_rewards, [{ user_id: u, reward_id: "rw-community", subject_key: RADIOHEAD, rule_id: "old", evidence: { plays: 1 } }]);
});

Deno.test("retroactive: loosening a rule then rules-evaluate(rule_id) grants the newly qualifying", async () => {
  const db = seed();
  const r = addRule(db, "artist_plays", { artist: BLINK, threshold: 182 }, "rw-blink");
  const a = addUser(db, 1, { "art-bl": 200 });
  const b = addUser(db, 2, { "art-bl": 120 });
  const c = addUser(db, 3, { "art-bl": 50 });
  assertEquals((await evaluate(asDb(db), { ruleId: r })).granted, 1);
  db.tables.rules[0].params = { artist: BLINK, threshold: 100 };
  assertEquals(await evaluate(asDb(db), { ruleId: r }), { evaluated_users: 3, granted: 1, skipped_rules: [] });
  assertEquals([grantsOf(db, a).length, grantsOf(db, b).length, grantsOf(db, c).length], [1, 1, 0]);
});

Deno.test("user_id limits evaluation to that user", async () => {
  const db = seed();
  addRule(db, "artist_plays", { artist: "*", threshold: 1 }, "rw-community");
  const a = addUser(db, 1, { "art-rh": 5 });
  addUser(db, 2, { "art-rh": 5 });
  assertEquals(await evaluate(asDb(db), { userId: a }), { evaluated_users: 1, granted: 1, skipped_rules: [] });
  assertEquals(db.tables.user_rewards.length, 1);
});

Deno.test("all-users path pages users and survives a server row cap smaller than the page", async () => {
  const db = seed(3); // PostgREST max_rows = 3
  addRule(db, "artist_plays", { artist: "*", threshold: 10 }, "rw-community");
  addRule(db, "album_unlocked", { album: "*" }, "rw-poster");
  for (let i = 1; i <= 7; i++) {
    addUser(db, i, { "art-rh": 10 + i, "art-bl": 5, "art-nu": 10 }, {
      "alb-okc": { airbag: 1, "paranoid android": 1, "karma police": i % 2 },
      "alb-modal": { feather: 2, "reflection eternal": 2 },
    });
  }
  const res = await evaluate(asDb(db), { pageSize: 2 });
  // 7 users x (RH + NU communities) + 7 Modal Soul posters + 4 OK Computer posters (odd i)
  assertEquals(res, { evaluated_users: 7, granted: 14 + 7 + 4, skipped_rules: [] });
  assertEquals(await evaluate(asDb(db), { pageSize: 2 }), { evaluated_users: 7, granted: 0, skipped_rules: [] });
});

Deno.test("album rules end to end: passes, artist albums, total albums; subject keys", async () => {
  const db = seed();
  addRule(db, "album_passes", { album: "*", threshold: 3 }, "rw-poster");
  addRule(db, "artist_albums_unlocked", { artist: "*", threshold: 1 }, "rw-community");
  addRule(db, "albums_unlocked", { threshold: 2 }, "rw-collector");
  const u = addUser(db, 1, {}, {
    "alb-okc": { airbag: 3, "paranoid android": 4, "karma police": 3 },
    "alb-modal": { feather: 9, "reflection eternal": 1 },
  });
  assertEquals(await evaluateUser(asDb(db), u), { granted: 1 + 2 + 1 });
  assertEquals(grantsOf(db, u), [`rw-collector|`, `rw-community|${NUJABES}`, `rw-community|${RADIOHEAD}`, `rw-poster|${OKC}`].sort());
  assertEquals(db.tables.user_rewards.find((g) => g.reward_id === "rw-poster")!.evidence, { type: "album_passes", passes: 3, threshold: 3, tracks: 3 });
});

Deno.test("a malformed rule is skipped and reported; the rest still grant", async () => {
  const db = seed();
  const bad = addRule(db, "artist_plays", { artist: "*", threshold: "lots" }, "rw-community");
  addRule(db, "artist_plays", { artist: BLINK, threshold: 1 }, "rw-blink");
  addUser(db, 1, { "art-bl": 5 });
  const res = await evaluate(asDb(db));
  assertEquals(res.granted, 1);
  assertEquals(res.skipped_rules.map((s) => s.rule_id), [bad]);
  await assertRejects(() => evaluate(asDb(db), { ruleId: bad }), RuleValidationError, "whole number");
  await assertRejects(() => evaluate(asDb(db), { ruleId: "nope" }), RuleNotFoundError);
});

Deno.test("date window: a future rule grants nothing now, and grants once it opens", async () => {
  const db = seed();
  addRule(db, "artist_plays", { artist: BLINK, threshold: 1 }, "rw-blink", { starts_at: "2026-10-01T00:00:00Z" });
  addUser(db, 1, { "art-bl": 5 });
  assertEquals((await evaluate(asDb(db), { now: new Date("2026-09-19T00:00:00Z") })).granted, 0);
  assertEquals((await evaluate(asDb(db), { now: new Date("2026-10-01T00:00:00Z") })).granted, 1);
});

// ------------------------------------------------------------------ dry run --

Deno.test("dry run: counts qualifying / new / already, samples subjects with names, NEVER writes", async () => {
  const db = seed(2);
  for (let i = 1; i <= 5; i++) addUser(db, i, { "art-rh": 100 * i, "art-nu": i >= 4 ? 150 : 10 });
  // User 5 already holds the Radiohead community.
  db.tables.user_rewards.push({ user_id: uid(5), reward_id: "rw-community", subject_key: RADIOHEAD, rule_id: null, evidence: {} });
  const before = structuredClone(db.tables);

  const res = await dryRun(asDb(db), { type: "artist_plays", params: { artist: "*", threshold: 150 }, reward_id: "00000000-0000-4000-8000-00000000c0de" })
    .catch((e) => e);
  assertEquals(res instanceof RuleValidationError, true); // unknown reward

  db.tables.rewards.push({ id: "00000000-0000-4000-8000-00000000c0de", kind: "community", subject_kind: "artist", artist_id: null, album_id: null });
  db.tables.user_rewards[0].reward_id = "00000000-0000-4000-8000-00000000c0de";
  before.rewards = structuredClone(db.tables.rewards);
  before.user_rewards = structuredClone(db.tables.user_rewards);

  const r = await dryRun(asDb(db), {
    type: "artist_plays",
    params: { artist: "*", threshold: 150 },
    reward_id: "00000000-0000-4000-8000-00000000c0de",
  }, { pageSize: 2 });
  // Radiohead: users 2..5 (200..500). Nujabes: users 4, 5.
  assertEquals(r, {
    qualifying_users: 4,
    new_grants: 5,
    already_granted: 1,
    subjects: 2,
    sample: [
      { subject_key: RADIOHEAD, subject_name: "Radiohead", users: 4 },
      { subject_key: NUJABES, subject_name: "Nujabes", users: 2 },
    ],
  });
  assertEquals(db.writes, []);
  assertEquals(db.tables, before);
});

Deno.test("dry run: ignores active/window, uses '' subject with null name for albums_unlocked", async () => {
  const db = seed();
  addUser(db, 1, {}, { "alb-modal": { feather: 1, "reflection eternal": 1 } });
  const reward = "00000000-0000-4000-8000-00000000beef";
  db.tables.rewards.push({ id: reward, kind: "sticker", subject_kind: null, artist_id: null, album_id: null });
  assertEquals(await dryRun(asDb(db), { type: "albums_unlocked", params: { threshold: 1 }, reward_id: reward }), {
    qualifying_users: 1,
    new_grants: 1,
    already_granted: 0,
    subjects: 1,
    sample: [{ subject_key: "", subject_name: null, users: 1 }],
  });
  assertEquals(db.writes, []);
});

Deno.test("dry run: malformed rules are rejected before any read", async () => {
  const db = seed();
  await assertRejects(
    () => dryRun(asDb(db), { type: "album_unlocked", params: { album: "*", threshold: 2 }, reward_id: uid(1) }),
    RuleValidationError,
    "use album_passes",
  );
  await assertRejects(() => dryRun(asDb(db), { type: "albums_unlocked", params: { threshold: 1 }, reward_id: "x" }), RuleValidationError, "uuid");
  assertEquals(db.requests, 0);
});
