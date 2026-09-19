/**
 * Shapes shared by the rewards client. The server-side contract these mirror is
 * docs/REWARDS.md section 9; the tables are in supabase/migrations/.
 */

export interface MilkUser {
  id: string;
  email: string | null;
}

export type LastfmReason =
  | 'bad_state'
  | 'expired_state'
  | 'already_linked'
  | 'lastfm_rejected'
  | 'server_error';

/** How a trip through Last.fm's approval page ended. */
export type LinkOutcome =
  | { status: 'ok' }
  | { status: 'error'; reason: LastfmReason | string }
  /** The browser was closed before Last.fm sent the user back. */
  | { status: 'cancelled' };

/** One `lastfm-sync` response, exactly as section 9 defines it. */
export interface SyncStep {
  done: boolean;
  pages_processed: number;
  plays_added: number;
  granted: number;
  /**
   * Not in section 9, but the function returns it: another sync for this
   * account holds the lock, so this call did nothing. Wait and call again.
   */
  busy?: boolean;
}

export interface SyncProgress {
  /** True while waiting out another sync that holds the lock. */
  waiting?: boolean;
  calls: number;
  pages: number;
  playsAdded: number;
  granted: number;
  done: boolean;
}

/** The caller's own `linked_accounts` row for Last.fm (never the session key). */
export interface LinkedLastfm {
  username: string;
  verifiedAt: string | null;
  lastSyncedAt: string | null;
}

export type RewardKind = 'sticker' | 'poster' | 'community';

/** A `user_rewards` row joined with its `rewards` row, subject resolved. */
export interface EarnedReward {
  /** Stable identity of a grant: reward id + subject key. */
  key: string;
  rewardId: string;
  kind: RewardKind;
  name: string;
  description: string | null;
  artUrl: string | null;
  /** '' for rewards with no subject. */
  subjectKey: string;
  /** Human name of the artist/album that earned a wildcard grant, if any. */
  subjectName: string | null;
  subjectKind: 'artist' | 'album' | null;
  grantedAt: string;
  evidence: Record<string, unknown>;
}

export class RewardsError extends Error {
  constructor(
    message: string,
    /** True when the backend is not reachable or not deployed yet. */
    readonly unavailable = false,
  ) {
    super(message);
  }
}
