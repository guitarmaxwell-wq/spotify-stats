// Rule TYPES are code (docs/REWARDS.md section 1). This file mirrors the v1 table:
// which params each type takes, and what a wildcard grants per-subject.

import type { DryRunRule, Reward, RuleDraft, RuleParams, RuleType, SubjectKind } from './types';

export interface RuleTypeDef {
  type: RuleType;
  label: string;
  /** Which target field the type takes, if any. */
  target: 'artist' | 'album' | null;
  hasThreshold: boolean;
  thresholdLabel: string;
  /** The subject a grant is recorded against (null: the reward has no subject). */
  subject: SubjectKind | null;
  explain: string;
  /** 1b types need the album catalog (tracklists) on the server. */
  milestone: '1a' | '1b';
}

export const RULE_TYPES: RuleTypeDef[] = [
  {
    type: 'artist_plays',
    label: 'Artist plays',
    target: 'artist',
    hasThreshold: true,
    thresholdLabel: 'Plays',
    subject: 'artist',
    explain: 'Earned when the user has at least N plays of the artist.',
    milestone: '1a',
  },
  {
    type: 'album_unlocked',
    label: 'Album unlocked',
    target: 'album',
    hasThreshold: false,
    thresholdLabel: '',
    subject: 'album',
    explain: 'Earned when every track on the album has been played at least once.',
    milestone: '1b',
  },
  {
    type: 'album_passes',
    label: 'Album passes',
    target: 'album',
    hasThreshold: true,
    thresholdLabel: 'Passes',
    subject: 'album',
    explain:
      'Earned when every track on the album has been played at least N times (passes = the lowest play count across its tracks).',
    milestone: '1b',
  },
  {
    type: 'artist_albums_unlocked',
    label: "Artist's albums unlocked",
    target: 'artist',
    hasThreshold: true,
    thresholdLabel: 'Albums',
    subject: 'artist',
    explain: "Earned when at least N of the artist's albums are unlocked.",
    milestone: '1b',
  },
  {
    type: 'albums_unlocked',
    label: 'Albums unlocked (total)',
    target: null,
    hasThreshold: true,
    thresholdLabel: 'Albums',
    subject: null,
    explain: 'Earned when at least N albums are unlocked in total, across all artists.',
    milestone: '1b',
  },
];

export function ruleTypeDef(type: RuleType): RuleTypeDef {
  return RULE_TYPES.find((d) => d.type === type)!;
}

export const WILDCARD = '*';

export function targetOf(type: RuleType, params: RuleParams): string | undefined {
  const def = ruleTypeDef(type);
  if (def.target === 'artist') return params.artist;
  if (def.target === 'album') return params.album;
  return undefined;
}

export function isWildcard(type: RuleType, params: RuleParams): boolean {
  return targetOf(type, params) === WILDCARD;
}

/** Keep only the params this type takes, so switching type never leaves stale keys. */
export function cleanParams(type: RuleType, params: RuleParams): RuleParams {
  const def = ruleTypeDef(type);
  const out: RuleParams = {};
  if (def.target === 'artist' && params.artist) out.artist = params.artist;
  if (def.target === 'album' && params.album) out.album = params.album;
  if (def.hasThreshold && params.threshold !== undefined) out.threshold = params.threshold;
  return out;
}

export function dryRunPayload(d: RuleDraft): DryRunRule {
  return { type: d.type, params: cleanParams(d.type, d.params), reward_id: d.reward_id };
}

export function payloadKey(d: RuleDraft): string {
  const p = dryRunPayload(d);
  return JSON.stringify([p.type, p.params.artist ?? null, p.params.album ?? null, p.params.threshold ?? null, p.reward_id]);
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Mirrors the rules_validate trigger: artist = MBID | name:<key> | '*', album = release MBID | '*'. */
export function targetFormatError(kind: 'artist' | 'album', key: string): string | null {
  if (key === WILDCARD || MBID.test(key)) return null;
  if (kind === 'artist' && /^name:.+/.test(key) && key === key.trim()) return null;
  if (MBID.test(key.toLowerCase())) return `"${key}" must be lowercase, as MusicBrainz ids are stored.`;
  return kind === 'artist'
    ? `"${key}" is not an artist MBID, a "name:<artistKey>" key, or "*".`
    : `"${key}" is not a release MBID or "*". Albums have no name: keys.`;
}

/**
 * Why this reward cannot be granted by this rule, or null if it can. Same rule as
 * the rules_validate trigger (docs/REWARDS.md section 9, "Reward compatibility"):
 *  - a wildcard needs a per-subject template of the rule's subject kind;
 *  - a specific rule may use a plain reward or a template of its own subject kind;
 *  - albums_unlocked has no subject, so no template at all.
 */
export function rewardIncompatibility(type: RuleType, target: string | undefined, reward: Reward): string | null {
  const def = ruleTypeDef(type);
  const template = reward.subject_kind !== null && !reward.artist_id && !reward.album_id;
  if (target === WILDCARD) {
    if (!(template && reward.subject_kind === def.subject)) {
      return `A wildcard rule grants one reward per ${def.subject}, so it needs a per-${def.subject} TEMPLATE reward (subject kind "${def.subject}", no specific artist or album). "${reward.name}" is not one.`;
    }
    return null;
  }
  if (template && reward.subject_kind !== def.subject) {
    return def.subject === null
      ? `"${def.label}" has no artist or album subject, so it cannot grant a per-${reward.subject_kind} template. Pick a reward with no subject kind.`
      : `"${reward.name}" is a per-${reward.subject_kind} template, but this rule is about an ${def.subject}.`;
  }
  return null;
}

export interface Issue {
  field: 'type' | 'target' | 'threshold' | 'reward' | 'window';
  level: 'error' | 'warning';
  message: string;
}

/** Everything wrong with a draft. Errors block the dry run and the save. */
export function validateDraft(d: RuleDraft, rewards: Reward[], targetArtistId?: string | null): Issue[] {
  const def = ruleTypeDef(d.type);
  const issues: Issue[] = [];
  const target = targetOf(d.type, d.params);

  if (def.target && !target) {
    issues.push({ field: 'target', level: 'error', message: `Pick an ${def.target}, or "Any ${def.target}".` });
  }

  if (def.hasThreshold) {
    const t = d.params.threshold;
    if (t === undefined || Number.isNaN(t)) {
      issues.push({ field: 'threshold', level: 'error', message: `${def.thresholdLabel} threshold is required.` });
    } else if (!Number.isInteger(t) || t < 1) {
      issues.push({ field: 'threshold', level: 'error', message: 'Threshold must be a whole number of 1 or more.' });
    } else if (t > 1_000_000) {
      issues.push({ field: 'threshold', level: 'error', message: 'Threshold must be at most 1,000,000.' });
    }
  }

  if (def.target && target && target !== WILDCARD) {
    const fmt = targetFormatError(def.target, target);
    if (fmt) issues.push({ field: 'target', level: 'error', message: fmt });
  }

  const reward = rewards.find((r) => r.id === d.reward_id);
  if (!d.reward_id) {
    issues.push({ field: 'reward', level: 'error', message: 'Pick a reward.' });
  } else if (!reward) {
    issues.push({ field: 'reward', level: 'error', message: 'That reward no longer exists.' });
  } else {
    const why = rewardIncompatibility(d.type, target, reward);
    if (why) issues.push({ field: 'reward', level: 'error', message: why });
    if (target !== WILDCARD && def.target === 'artist' && reward.artist_id && targetArtistId && reward.artist_id !== targetArtistId) {
      issues.push({
        field: 'reward',
        level: 'warning',
        message: `"${reward.name}" belongs to a different artist than this rule targets.`,
      });
    }
  }

  if (d.starts_at && d.ends_at && new Date(d.ends_at) <= new Date(d.starts_at)) {
    issues.push({ field: 'window', level: 'error', message: 'The window must end after it starts.' });
  }
  if (d.ends_at && new Date(d.ends_at) < new Date()) {
    issues.push({
      field: 'window',
      level: 'warning',
      message: 'The window has already ended, so this rule will grant nothing new.',
    });
  }
  return issues;
}
