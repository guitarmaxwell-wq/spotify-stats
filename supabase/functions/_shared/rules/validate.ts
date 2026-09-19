// Rule validation. Pure: no database access.
//
// Error messages are shown verbatim to an admin in the dashboard, so they say
// what is wrong AND what to do about it. The same checks are mirrored in SQL by
// the `rules_validate` trigger (migration 20260919010000), so a malformed rule
// cannot be saved even by a client that skips the dry run; keep the two in sync.

import {
  type ParsedParams,
  type ParsedRule,
  type RewardRow,
  RULE_TYPES,
  type RuleRow,
  type RuleType,
} from "./types.ts";

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleValidationError";
  }
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_THRESHOLD = 1_000_000;

/** Which params each type takes. Anything else is rejected, to catch typos. */
const ALLOWED: Record<RuleType, readonly string[]> = {
  artist_plays: ["artist", "threshold"],
  album_unlocked: ["album"],
  album_passes: ["album", "threshold"],
  artist_albums_unlocked: ["artist", "threshold"],
  albums_unlocked: ["threshold"],
};

/** The kind of subject a rule type is about, or null for none. */
export function subjectKindOf(type: RuleType): "artist" | "album" | null {
  switch (type) {
    case "artist_plays":
    case "artist_albums_unlocked":
      return "artist";
    case "album_unlocked":
    case "album_passes":
      return "album";
    case "albums_unlocked":
      return null;
  }
}

function fail(msg: string): never {
  throw new RuleValidationError(msg);
}

function isRuleType(t: unknown): t is RuleType {
  return typeof t === "string" && (RULE_TYPES as readonly string[]).includes(t);
}

function artistParam(v: unknown): string {
  if (v === undefined) fail('params.artist is required: an artist MBID, "name:<artistKey>", or "*" for every artist.');
  if (typeof v !== "string") fail('params.artist must be a string: an artist MBID, "name:<artistKey>", or "*".');
  if (v === "*") return v;
  if (MBID.test(v)) return v;
  if (v.startsWith("name:") && v.length > 5 && v.trim() === v) return v;
  if (MBID.test(v.toLowerCase())) fail(`params.artist "${v}" must be lowercase, as MusicBrainz ids are stored.`);
  fail(`params.artist "${v}" is not an artist MBID, a "name:<artistKey>" key, or "*".`);
}

function albumParam(v: unknown): string {
  if (v === undefined) fail('params.album is required: a release MBID, or "*" for every album.');
  if (typeof v !== "string") fail('params.album must be a string: a release MBID, or "*".');
  if (v === "*") return v;
  if (MBID.test(v)) return v;
  if (MBID.test(v.toLowerCase())) fail(`params.album "${v}" must be lowercase, as MusicBrainz ids are stored.`);
  fail(`params.album "${v}" is not a release MBID or "*".`);
}

function thresholdParam(v: unknown): number {
  if (v === undefined) fail("params.threshold is required: a whole number of at least 1.");
  if (typeof v !== "number" || !Number.isInteger(v)) {
    fail(`params.threshold must be a whole number, not ${JSON.stringify(v)}.`);
  }
  if (v < 1) fail(`params.threshold must be at least 1, not ${v}.`);
  if (v > MAX_THRESHOLD) fail(`params.threshold must be at most ${MAX_THRESHOLD}, not ${v}.`);
  return v;
}

/** Validate a rule's type and params. Throws RuleValidationError. */
export function parseParams(type: unknown, params: unknown): ParsedParams {
  if (!isRuleType(type)) {
    fail(`Unknown rule type ${JSON.stringify(type)}. Expected one of: ${RULE_TYPES.join(", ")}.`);
  }
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    fail("params must be a JSON object.");
  }
  const p = params as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => !ALLOWED[type].includes(k));
  if (extra.length) {
    const hint = type === "album_unlocked" && extra.includes("threshold")
      ? ' album_unlocked has no threshold (it means one full pass); use album_passes for "N passes".'
      : "";
    fail(`${type} does not take ${extra.map((k) => `params.${k}`).join(", ")}. It takes: ${ALLOWED[type].join(", ")}.${hint}`);
  }
  switch (type) {
    case "artist_plays":
      return { type, artist: artistParam(p.artist), threshold: thresholdParam(p.threshold) };
    case "album_unlocked":
      return { type, album: albumParam(p.album) };
    case "album_passes":
      return { type, album: albumParam(p.album), threshold: thresholdParam(p.threshold) };
    case "artist_albums_unlocked":
      return { type, artist: artistParam(p.artist), threshold: thresholdParam(p.threshold) };
    case "albums_unlocked":
      return { type, threshold: thresholdParam(p.threshold) };
  }
}

export function isWildcard(p: ParsedParams): boolean {
  return ("artist" in p && p.artist === "*") || ("album" in p && p.album === "*");
}

/**
 * Check that the reward can be granted by this rule.
 *
 * - A wildcard rule grants one reward PER SUBJECT, so its reward must be a
 *   template (subject_kind set, no specific artist/album) of the matching kind.
 *   Otherwise one fixed sticker would be granted once per artist.
 * - A template reward on any rule needs a subject of its kind to resolve its
 *   art from, so `albums_unlocked` (no subject) cannot grant a template, and an
 *   artist rule cannot grant an album template.
 */
export function checkReward(p: ParsedParams, reward: RewardRow | undefined): void {
  if (!reward) fail("reward_id does not refer to an existing reward.");
  const kind = subjectKindOf(p.type);
  const isTemplate = reward.subject_kind !== null && reward.artist_id === null && reward.album_id === null;
  if (isWildcard(p)) {
    if (!isTemplate || reward.subject_kind !== kind) {
      fail(
        `A wildcard ${p.type} rule grants one reward per ${kind}, so its reward must be a per-${kind} template ` +
          `(subject_kind "${kind}" with no specific artist or album). This reward is not.`,
      );
    }
    return;
  }
  if (isTemplate && reward.subject_kind !== kind) {
    fail(
      kind === null
        ? `${p.type} has no artist or album subject, so it cannot grant a per-${reward.subject_kind} template reward. Pick a reward with no subject kind.`
        : `This reward is a per-${reward.subject_kind} template, but ${p.type} rules are about an ${kind}.`,
    );
  }
}

/** Validate a stored rule row plus its reward. Throws RuleValidationError. */
export function parseRule(row: RuleRow, reward: RewardRow | undefined): ParsedRule {
  const params = parseParams(row.type, row.params);
  checkReward(params, reward);
  return {
    id: row.id,
    reward_id: row.reward_id,
    params,
    active: row.active,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
  };
}
