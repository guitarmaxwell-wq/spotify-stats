import type { EarnedReward } from '../rewards/types';

/**
 * Why this sticker was earned, from the grant's `evidence`, in one line:
 * "184 plays of Radiohead", or the reward's own description as a fallback.
 */
export function earnedLine(r: EarnedReward): string {
  const plays = typeof r.evidence.plays === 'number' ? r.evidence.plays : null;
  if (plays !== null && r.subjectName) return `${plays.toLocaleString()} plays of ${r.subjectName}`;
  const threshold = typeof r.evidence.threshold === 'number' ? r.evidence.threshold : null;
  if (plays !== null && threshold !== null) {
    return `${plays.toLocaleString()} plays · needed ${threshold.toLocaleString()}`;
  }
  if (plays !== null) return `${plays.toLocaleString()} plays`;
  return r.description ?? 'Earned by listening';
}

export function grantedOn(r: EarnedReward): string {
  const d = new Date(r.grantedAt);
  return isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
