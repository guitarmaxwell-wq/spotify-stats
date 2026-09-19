// Types shared by the rule engine. Nothing in this file touches a database.

export const RULE_TYPES = [
  "artist_plays",
  "album_unlocked",
  "album_passes",
  "artist_albums_unlocked",
  "albums_unlocked",
] as const;

export type RuleType = (typeof RULE_TYPES)[number];

/** A `rules` row, as stored. `params` is unvalidated JSON. */
export interface RuleRow {
  id: string;
  type: string;
  params: unknown;
  reward_id: string;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

/** The columns of a `rewards` row the engine cares about. */
export interface RewardRow {
  id: string;
  kind: string;
  subject_kind: "artist" | "album" | null;
  artist_id: string | null;
  album_id: string | null;
}

/** `*` or a concrete key. */
export type Target = "*" | string;

/** A rule whose params have been validated. Discriminated on `type`. */
export type ParsedParams =
  | { type: "artist_plays"; artist: Target; threshold: number }
  | { type: "album_unlocked"; album: Target }
  | { type: "album_passes"; album: Target; threshold: number }
  | { type: "artist_albums_unlocked"; artist: Target; threshold: number }
  | { type: "albums_unlocked"; threshold: number };

export interface ParsedRule {
  id: string;
  reward_id: string;
  params: ParsedParams;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

/**
 * One user's aggregates, in the shape the pure decision logic consumes.
 *
 * Artist and album keys are the SUBJECT KEYS used in `user_rewards.subject_key`:
 * `artists.mbid` (a real MBID or the synthetic `name:<artistKey>`) and
 * `albums.release_mbid`.
 */
export interface UserAggregates {
  /** artist key -> plays */
  artistPlays: Map<string, number>;
  /** Albums the user has at least one track play on. */
  albums: AlbumAggregate[];
}

export interface AlbumAggregate {
  /** release MBID */
  key: string;
  /** Album artist's key (`artists.mbid`), or null if the album has no artist. */
  artistKey: string | null;
  /** Normalized track keys, as in `albums.tracklist`. */
  tracklist: string[];
  /** track key -> plays, for this user and this album. */
  trackPlays: Map<string, number>;
}

/** A grant the evaluator has decided on. Maps 1:1 onto a `user_rewards` row. */
export interface Grant {
  user_id: string;
  reward_id: string;
  subject_key: string;
  rule_id: string;
  evidence: Record<string, unknown>;
}
