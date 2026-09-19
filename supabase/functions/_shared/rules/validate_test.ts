// Rule validation. The same cases were run against the SQL trigger
// (migration 20260919010000) so the two stay in agreement.

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { checkReward, parseParams, RuleValidationError } from "./validate.ts";
import type { RewardRow } from "./types.ts";

const BLINK = "0743b15a-3c32-48c8-ad58-cb325350befa";
const ARTIST_TMPL: RewardRow = { id: "r1", kind: "community", subject_kind: "artist", artist_id: null, album_id: null };
const PLAIN: RewardRow = { id: "r2", kind: "sticker", subject_kind: null, artist_id: null, album_id: null };
const ALBUM_TMPL: RewardRow = { id: "r3", kind: "poster", subject_kind: "album", artist_id: null, album_id: null };
const PINNED_ARTIST: RewardRow = { id: "r4", kind: "sticker", subject_kind: "artist", artist_id: "a1", album_id: null };

function rejects(type: unknown, params: unknown, fragment: string) {
  const e = assertThrows(() => parseParams(type, params), RuleValidationError);
  if (!e.message.includes(fragment)) throw new Error(`expected "${fragment}" in: ${e.message}`);
}

Deno.test("valid params parse to typed rules", () => {
  assertEquals(parseParams("artist_plays", { artist: "*", threshold: 100 }), { type: "artist_plays", artist: "*", threshold: 100 });
  assertEquals(parseParams("artist_plays", { artist: BLINK, threshold: 182 }), { type: "artist_plays", artist: BLINK, threshold: 182 });
  assertEquals(parseParams("artist_plays", { artist: "name:blink 182", threshold: 1 }).type, "artist_plays");
  assertEquals(parseParams("album_unlocked", { album: "*" }), { type: "album_unlocked", album: "*" });
  assertEquals(parseParams("album_passes", { album: BLINK, threshold: 5 }), { type: "album_passes", album: BLINK, threshold: 5 });
  assertEquals(parseParams("artist_albums_unlocked", { artist: "*", threshold: 3 }).type, "artist_albums_unlocked");
  assertEquals(parseParams("albums_unlocked", { threshold: 10 }), { type: "albums_unlocked", threshold: 10 });
});

Deno.test("malformed params are rejected with a human message", () => {
  rejects("nope", {}, "Unknown rule type");
  rejects(undefined, {}, "Unknown rule type");
  rejects("artist_plays", null, "params must be a JSON object");
  rejects("artist_plays", [1], "params must be a JSON object");
  rejects("album_unlocked", { album: "*", threshold: 3 }, "use album_passes");
  rejects("artist_plays", { artist: "*", threshold: 1, artsit: "x" }, "does not take params.artsit");
  rejects("artist_plays", { artist: "*" }, "params.threshold is required");
  rejects("artist_plays", { artist: "*", threshold: "100" }, "whole number");
  rejects("artist_plays", { artist: "*", threshold: 1.5 }, "whole number");
  rejects("artist_plays", { artist: "*", threshold: 0 }, "at least 1");
  rejects("artist_plays", { artist: "*", threshold: -5 }, "at least 1");
  rejects("artist_plays", { artist: "*", threshold: 1_000_001 }, "at most");
  rejects("artist_plays", { artist: "*", threshold: Infinity }, "whole number");
  rejects("artist_plays", { threshold: 1 }, "params.artist is required");
  rejects("artist_plays", { artist: 42, threshold: 1 }, "must be a string");
  rejects("artist_plays", { artist: "Radiohead", threshold: 1 }, "is not an artist MBID");
  rejects("artist_plays", { artist: BLINK.toUpperCase(), threshold: 1 }, "must be lowercase");
  rejects("artist_plays", { artist: "name:", threshold: 1 }, "is not an artist MBID");
  rejects("artist_plays", { artist: "name:x ", threshold: 1 }, "is not an artist MBID");
  rejects("album_unlocked", { album: "name:x" }, "is not a release MBID");
  rejects("album_passes", { album: "*" }, "params.threshold is required");
  rejects("albums_unlocked", { threshold: 1, artist: "*" }, "does not take params.artist");
});

Deno.test("reward compatibility", () => {
  const p = (type: string, params: unknown) => parseParams(type, params);
  const bad = (pp: ReturnType<typeof p>, r: RewardRow | undefined, frag: string) => {
    const e = assertThrows(() => checkReward(pp, r), RuleValidationError);
    if (!e.message.includes(frag)) throw new Error(`expected "${frag}" in: ${e.message}`);
  };
  // OK
  checkReward(p("artist_plays", { artist: "*", threshold: 1 }), ARTIST_TMPL);
  checkReward(p("album_passes", { album: "*", threshold: 1 }), ALBUM_TMPL);
  checkReward(p("artist_plays", { artist: BLINK, threshold: 1 }), PLAIN);
  checkReward(p("artist_plays", { artist: BLINK, threshold: 1 }), ARTIST_TMPL);
  checkReward(p("artist_plays", { artist: BLINK, threshold: 1 }), PINNED_ARTIST);
  checkReward(p("albums_unlocked", { threshold: 1 }), PLAIN);
  // Rejected
  bad(p("artist_plays", { artist: "*", threshold: 1 }), undefined, "existing reward");
  bad(p("artist_plays", { artist: "*", threshold: 1 }), PLAIN, "per-artist template");
  bad(p("artist_plays", { artist: "*", threshold: 1 }), PINNED_ARTIST, "per-artist template");
  bad(p("album_passes", { album: "*", threshold: 1 }), ARTIST_TMPL, "per-album template");
  bad(p("albums_unlocked", { threshold: 1 }), ARTIST_TMPL, "no artist or album subject");
  bad(p("artist_plays", { artist: BLINK, threshold: 1 }), ALBUM_TMPL, "per-album template");
});
