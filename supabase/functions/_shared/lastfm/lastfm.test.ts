// deno test -A supabase/functions/_shared/lastfm/
//
// Mock-level tests. The live checks are in harness.ts (real Last.fm) and
// sql_tests.sql (real Postgres).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { apiSig, authUrl, getSession, md5Hex, parseRecentTracks } from "./api.ts";
import { artistKey } from "./normalize.ts";
import * as app from "../../../../app/src/link/normalize.ts";
import { LOOKBACK_S, nextStep, runChunk } from "./sync.ts";
import { FakeLastfm, MemoryStore, resolveCounts } from "./testing.ts";
import { parseCallback } from "./callback.ts";

// ------------------------------------------------------------- api_sig --

Deno.test("md5 matches known vectors", () => {
  assertEquals(md5Hex(""), "d41d8cd98f00b204e9800998ecf8427e");
  assertEquals(md5Hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
});

Deno.test("api_sig reproduces Last.fm's documented auth.getSession example", () => {
  // https://www.last.fm/api/webauth: md5("api_keyxxxxxxxxmethodauth.getSessiontokenxxxxxxxmysecret").
  // Reference value computed independently with coreutils md5sum.
  const sig = apiSig({ token: "xxxxxxx", method: "auth.getSession", api_key: "xxxxxxxx", format: "json" }, "mysecret");
  assertEquals(sig, "68afb32bee072407a63b6c41f3e1e2b4");
});

Deno.test("api_sig sorts params and excludes format and callback", () => {
  const sig = apiSig({
    token: "Y0uRt0k3N",
    method: "auth.getSession",
    api_key: "b25b959554ed76058ac220b7b2e0a026",
    format: "json",
    callback: "cb",
  }, "secret123");
  assertEquals(sig, "26c69faf0b5dc5ec3667a639d45c075c");
});

Deno.test("getSession posts a signed request and returns name + key", async () => {
  let sent: URLSearchParams | null = null;
  const fake = ((_url: string, init: RequestInit) => {
    sent = new URLSearchParams(init.body as URLSearchParams);
    return Promise.resolve(new Response(JSON.stringify({ session: { name: "Maxchambersss", key: "SK", subscriber: 0 } })));
  }) as unknown as typeof fetch;
  const s = await getSession("TOK", "KEY", "SECRET", fake);
  assertEquals(s, { name: "Maxchambersss", key: "SK" });
  assertEquals(sent!.get("api_sig"), md5Hex("api_keyKEYmethodauth.getSessiontokenTOKSECRET"));
  assertEquals(sent!.get("format"), "json");
});

Deno.test("getSession surfaces Last.fm errors with their code", async () => {
  const fake = (() => Promise.resolve(new Response(JSON.stringify({ error: 4, message: "Invalid token" }), { status: 403 }))) as unknown as typeof fetch;
  let code: number | undefined;
  try {
    await getSession("bad", "KEY", "SECRET", fake);
  } catch (e) {
    code = (e as { code?: number }).code;
  }
  assertEquals(code, 4);
});

Deno.test("authUrl carries api_key and an encoded per-request cb", () => {
  const u = new URL(authUrl("KEY", "https://x.supabase.co/functions/v1/lastfm-auth-complete?state=abc"));
  assertEquals(u.origin + u.pathname, "https://www.last.fm/api/auth/");
  assertEquals(u.searchParams.get("api_key"), "KEY");
  assertEquals(u.searchParams.get("cb"), "https://x.supabase.co/functions/v1/lastfm-auth-complete?state=abc");
});

Deno.test("callback parsing: documented &token= and a stray ?token=", () => {
  assertEquals(parseCallback(new URL("https://f/x?state=S&token=T")), { state: "S", token: "T" });
  assertEquals(parseCallback(new URL("https://f/x?state=S?token=T")), { state: "S", token: "T" });
  assertEquals(parseCallback(new URL("https://f/x?token=T")), { state: null, token: "T" });
  assertEquals(parseCallback(new URL("https://f/x?state=S")), { state: "S", token: null });
});

// -------------------------------------------------------------- parsing --

Deno.test("now playing is never a scrobble, even if it grew a date", () => {
  const p = parseRecentTracks({
    recenttracks: {
      "@attr": { totalPages: "1", total: "1" },
      track: [
        { "@attr": { nowplaying: "true" }, artist: { "#text": "A", mbid: "" }, name: "now" },
        { "@attr": { nowplaying: "true" }, artist: { "#text": "A", mbid: "" }, name: "now2", date: { uts: "5" } },
        { artist: { "#text": "B", mbid: "ABC" }, name: "t", date: { uts: "10" } },
        { artist: { "#text": "", mbid: "" }, name: "t", date: { uts: "11" } },
        { artist: { "#text": "C" }, name: "t" },
      ],
    },
  });
  assertEquals(p.scrobbles, [{ uts: 10, artist: "B", track: "t", mbid: "abc" }]);
  assertEquals(p.skipped, 4);
});

Deno.test("a single track arrives as a bare object", () => {
  const p = parseRecentTracks({
    recenttracks: { "@attr": { totalPages: "1", total: "1" }, track: { artist: { "#text": "B" }, name: "t", date: { uts: "10" } } },
  });
  assertEquals(p.scrobbles.length, 1);
});

// ------------------------------------------------------------ normalize --

const PARITY = [
  "The Nat King Cole Trio", "Nat King Cole", "Beyoncé", "Tyler, The Creator", "Jay-Z & Kanye West",
  "Miles Davis feat. John Coltrane", "Nas", "Nasty Nas", "The Roots", "Roots Manuva", "¥$", "blink-182",
  "2Pac", "2pac", "Tupac", "Sum 41", "AC/DC", "Simon & Garfunkel", "Crosby, Stills, Nash & Young",
  "The Jimi Hendrix Experience", "Guns N' Roses", "Guns N’ Roses", "Sigur Rós", "?", "!!!",
  "フランク・クニモンド・トリオ", "Mötley Crüe", "Earth, Wind & Fire", "A Tribe Called Quest",
  "The The", "An Albatross", "MF DOOM", "Artist - Remastered", "Band (Deluxe)", "", "  ",
];

Deno.test("artistKey port is identical to the app's normalizer", () => {
  for (const s of PARITY) assertEquals(artistKey(s), app.artistKey(s), `artistKey(${JSON.stringify(s)})`);
});

Deno.test("artistKey folds the pipeline's variant cases", () => {
  const pairs: [string, string][] = [
    ["The Nat King Cole Trio", "Nat King Cole"], ["Nat King Cole Trio", "Nat King Cole"],
    ["The Beatles", "Beatles"], ["Beyoncé", "Beyonce"], ["Tyler, The Creator", "Tyler"],
    ["Jay-Z & Kanye West", "Jay Z"], ["Miles Davis feat. John Coltrane", "Miles Davis"],
  ];
  for (const [a, b] of pairs) assertEquals(artistKey(a), artistKey(b), `${a} ~ ${b}`);
  assert(artistKey("Nas") !== artistKey("Nasty Nas"));
  assert(artistKey("The Roots") !== artistKey("Roots Manuva"));
  assertEquals(artistKey("¥$"), "¥$");
  assertEquals(artistKey("blink-182"), "blink 182");
});

Deno.test("the escaped hyphen: 'X - Remastered' loses its suffix", () => {
  assertEquals(app.cleanTitle("Song - Remastered"), "Song");
  assertEquals(artistKey("Band - Remastered"), app.artistKey("Band - Remastered"));
});

// ----------------------------------------------------------------- walk --

Deno.test("nextStep shrinks `to` to min+1 and finishes on the last page", () => {
  const w = { from: null, to: 100, walkTo: 100, walkPage: 1 };
  const page = (uts: number[], totalPages: number) => ({
    scrobbles: uts.map((u) => ({ uts: u, artist: "a", track: "t", mbid: null })), skipped: 0, totalPages, total: 0,
  });
  assertEquals(nextStep(w, page([99, 90, 80], 3)), { done: false, nextTo: 81, nextPage: 1 });
  assertEquals(nextStep(w, page([99, 90, 80], 1)), { done: true, nextTo: null, nextPage: null });
  assertEquals(nextStep(w, page([], 0)), { done: true, nextTo: null, nextPage: null });
  // Whole page in the second just below `to`: page forward instead of stalling.
  assertEquals(nextStep(w, page([99, 99, 99], 2)), { done: false, nextTo: 100, nextPage: 2 });
});

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/** Drive a whole sync through many small chunks, like the app would. */
async function syncToDone(store: MemoryStore, fetchPage: ReturnType<FakeLastfm["fetcher"]>, maxPages = 3) {
  let calls = 0;
  while (true) {
    const r = await runChunk({ store, fetchPage, maxPages, budgetMs: 1e9 });
    calls++;
    if (r.done) return calls;
    if (calls > 10000) throw new Error("no progress");
  }
}

Deno.test("exact: dense ties across page boundaries, over many resumed chunks", async () => {
  const r = rng(7);
  const fm = new FakeLastfm();
  let t = 1_000_000;
  for (let i = 0; i < 2345; i++) {
    if (r() < 0.6) t += 1 + Math.floor(r() * 3); // lots of same-second ties
    fm.add({ uts: t, artist: `A${Math.floor(r() * 20)}`, track: `T${i}`, mbid: null });
  }
  const store = new MemoryStore(() => t + 10);
  const calls = await syncToDone(store, fm.fetcher(50));
  assert(calls > 5, `expected many resumable calls, got ${calls}`);
  assertEquals(store.ledger.size, 2345);
});

Deno.test("exact: more than a page of scrobbles in ONE second", async () => {
  const fm = new FakeLastfm();
  for (let i = 0; i < 130; i++) fm.add({ uts: 500, artist: "A", track: `T${i}`, mbid: null });
  for (let i = 0; i < 70; i++) fm.add({ uts: 400 + i, artist: "B", track: `U${i}`, mbid: null });
  const store = new MemoryStore(() => 1000);
  await syncToDone(store, fm.fetcher(50));
  assertEquals(store.ledger.size, 200);
});

Deno.test("exact: two overlapping syncs plus late scrobbles never double count", async () => {
  const fm = new FakeLastfm();
  let now = 10_000_000;
  for (let i = 0; i < 900; i++) fm.add({ uts: now - 900 * 600 + i * 600, artist: "A", track: `T${i}`, mbid: null });
  const store = new MemoryStore(() => now);
  await syncToDone(store, fm.fetcher(40));
  assertEquals(store.ledger.size, 900);

  // Time passes: new plays, and an offline batch arrives with timestamps from
  // three days ago (behind the cursor, inside the look-back).
  now += 3600;
  for (let i = 0; i < 25; i++) fm.add({ uts: now - 3000 + i * 10, artist: "B", track: `N${i}`, mbid: null });
  for (let i = 0; i < 7; i++) fm.add({ uts: now - 3 * 86400 + i, artist: "C", track: `L${i}`, mbid: null });
  await syncToDone(store, fm.fetcher(40));
  assertEquals(store.ledger.size, 932);

  // A third sync with nothing new re-reads the look-back window and adds zero.
  now += 60;
  await syncToDone(store, fm.fetcher(40));
  assertEquals(store.ledger.size, 932);
  assertEquals(store.cursor, now);
  assert(LOOKBACK_S >= 14 * 86400);
});

Deno.test("exact: scrobbles added and deleted mid-walk cannot shift the walk", async () => {
  const fm = new FakeLastfm();
  for (let i = 0; i < 1000; i++) fm.add({ uts: 100_000 + i * 10, artist: "A", track: `T${i}`, mbid: null });
  const store = new MemoryStore(() => 200_000);
  const fetch = fm.fetcher(50, (n) => {
    // Every few requests, the user deletes one old scrobble and a late one
    // lands deep in the already-walked region -- the classic page-shift.
    if (n % 3 === 0) fm.remove((s) => s.track === `T${n}`);
    if (n % 4 === 0) fm.add({ uts: 100_000 + 9990 - n * 7 + 5, artist: "Late", track: `X${n}`, mbid: null });
  });
  await syncToDone(store, fetch);
  // Every original scrobble that survived long enough to be seen is counted
  // once; nothing is counted twice (the ledger is keyed, so size <= distinct).
  const ids = new Set(fm.scrobbles.map(MemoryStore.id));
  for (const id of store.ledger.keys()) assert(ids.has(id) || id.includes(" A\nT"), `phantom ${id}`);
  const survivingOriginals = fm.scrobbles.filter((s) => s.artist === "A");
  for (const s of survivingOriginals) assert(store.ledger.has(MemoryStore.id(s)), `missed ${s.track}`);
});

Deno.test("resumable: a stale concurrent call cannot move the walk", async () => {
  const fm = new FakeLastfm();
  for (let i = 0; i < 300; i++) fm.add({ uts: 1000 + i, artist: "A", track: `T${i}`, mbid: null });
  const store = new MemoryStore(() => 5000);
  const b = await store.begin();
  assert(b.status === "ok");
  assertEquals((await store.begin()).status, "busy");
  // Simulate another call having ingested [1200, to) and advanced the walk.
  const expect = { walkTo: b.window.walkTo, walkPage: 1 };
  const theirs = fm.scrobbles.filter((s) => s.uts >= 1200).map((s) => ({ ...s, key: artistKey(s.artist) }));
  await store.ingest(expect, theirs, { done: false, nextTo: 1200, nextPage: 1 });
  const again = await store.ingest(expect, [{ uts: 1, artist: "x", track: "y", key: "x", mbid: null }], { done: false, nextTo: 10, nextPage: 1 });
  assertEquals(again, { applied: false, inserted: 0 });
  await store.release();
  await syncToDone(store, fm.fetcher(50));
  assertEquals(store.ledger.size, 300);
});

Deno.test("now-playing in the feed is never counted across syncs", async () => {
  const fm = new FakeLastfm();
  for (let i = 0; i < 10; i++) fm.add({ uts: 1000 + i, artist: "A", track: `T${i}`, mbid: null });
  const raw = {
    recenttracks: {
      "@attr": { totalPages: "1", total: "10" },
      track: [{ "@attr": { nowplaying: "true" }, artist: { "#text": "NP" }, name: "np" }],
    },
  };
  assertEquals(parseRecentTracks(raw).scrobbles.length, 0);
});

// ------------------------------------------------------------ resolution --

const row = (uts: number, artist: string, mbid: string | null) => ({ uts, artist, track: `t${uts}`, key: artistKey(artist), mbid });

Deno.test("resolution: MBID-less plays merge onto the user's own single MBID", () => {
  const ledger = [row(1, "2Pac", "m-2pac"), row(2, "2Pac", "m-2pac"), row(3, "2Pac", null), row(4, "2pac", null)];
  const c = resolveCounts(ledger);
  assertEquals(c.get("m-2pac"), 4);
  assertEquals(c.has("name:2pac"), false);
});

Deno.test("resolution: a name-only scrobble resolves to the seeded catalog MBID", () => {
  const c = resolveCounts([row(1, "blink-182", null)], [["m-blink", "blink-182"]]);
  assertEquals(c.get("m-blink"), 1);
});

Deno.test("resolution: an ambiguous name stays synthetic", () => {
  const c = resolveCounts([row(1, "Nirvana", "m-n1"), row(2, "Nirvana", null)], [["m-n2", "Nirvana"]]);
  assertEquals(c.get("name:nirvana"), 1);
  assertEquals(c.get("m-n1"), 1);
});

Deno.test("resolution: consolidation when an MBID appears later, exact partition", () => {
  const ledger = [row(1, "Foo", null), row(2, "Foo", null)];
  assertEquals(resolveCounts(ledger).get("name:foo"), 2);
  ledger.push(row(3, "Foo", "m-foo"));
  const c = resolveCounts(ledger);
  assertEquals(c.get("m-foo"), 3);
  assertEquals(c.has("name:foo"), false);
  assertEquals([...c.values()].reduce((a, b) => a + b, 0), ledger.length);
});
