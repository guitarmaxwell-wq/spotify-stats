// Row shapes from supabase/migrations/20260919000000_rewards_core.sql, and the
// Edge Function contracts from docs/REWARDS.md section 9.

export type RuleType =
  | 'artist_plays'
  | 'album_unlocked'
  | 'album_passes'
  | 'artist_albums_unlocked'
  | 'albums_unlocked';

export type RewardKind = 'sticker' | 'poster' | 'community';
export type SubjectKind = 'artist' | 'album';

export interface RuleParams {
  artist?: string; // MBID, `name:<artistKey>`, or '*'
  album?: string; // release MBID or '*'
  threshold?: number;
}

export interface Rule {
  id: string;
  type: RuleType;
  params: RuleParams;
  reward_id: string;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  notes: string | null;
  updated_by: string | null;
  updated_at: string;
  created_at: string;
}

/** Everything an admin edits on a rule. */
export interface RuleDraft {
  type: RuleType;
  params: RuleParams;
  reward_id: string;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  notes: string | null;
}

export interface Reward {
  id: string;
  kind: RewardKind;
  name: string;
  description: string | null;
  art_url: string | null;
  subject_kind: SubjectKind | null;
  artist_id: string | null;
  album_id: string | null;
  created_at: string;
}

export type RewardDraft = Omit<Reward, 'id' | 'created_at'>;

export interface Artist {
  id: string;
  mbid: string;
  name: string;
}

export interface Album {
  id: string;
  release_mbid: string;
  artist_id: string | null;
  title: string;
  artist_name?: string | null;
  track_count?: number;
}

// ---- section 9 ----

/** The body of `rules-dry-run`: exactly { rule: { type, params, reward_id } }. */
export interface DryRunRule {
  type: RuleType;
  params: RuleParams;
  reward_id: string;
}

/**
 * qualifying_users counts USERS. new_grants and already_granted count (user,
 * subject) GRANTS, so for a wildcard rule they can exceed qualifying_users.
 * The dry run ignores active, starts_at and ends_at.
 */
export interface DryRunResult {
  qualifying_users: number;
  new_grants: number;
  already_granted: number;
  subjects: number;
  /** Up to 10 subjects, most users first. subject_name is null when subject_key is '' (albums_unlocked). */
  sample: { subject_key: string; subject_name: string | null; users: number }[];
}

export interface EvaluateResult {
  evaluated_users: number;
  granted: number;
  /** Malformed rules skipped by an evaluate-all run. */
  skipped_rules?: { rule_id: string; error: string }[];
}

export interface Session {
  userId: string;
  email: string | null;
}
