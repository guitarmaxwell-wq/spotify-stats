// Shared rule evaluator (docs/REWARDS.md sections 4 and 9).
//
// Load (load.ts) -> decide (decide.ts, pure) -> write (here). The only write is
// an INSERT ... ON CONFLICT (user_id, reward_id, subject_key) DO NOTHING into
// `user_rewards`: an existing grant is never updated or deleted, so tightening
// or retiring a rule can only stop NEW grants.
//
// `db` must be a service-role client; no client role can write user_rewards.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { decideGrants, isLive } from "./decide.ts";
import { type AlbumCache, chunks, loadAggregates, loadRules, needsOf, type RuleLoadError, userPages } from "./load.ts";
import { RuleValidationError } from "./validate.ts";
import type { Grant, ParsedRule } from "./types.ts";

/**
 * Insert grants the user does not already hold. Returns how many were NEW.
 * `ignoreDuplicates` makes this ON CONFLICT DO NOTHING, and RETURNING then
 * yields only the rows actually inserted.
 */
export async function writeGrants(db: SupabaseClient, grants: readonly Grant[]): Promise<number> {
  let inserted = 0;
  for (const c of chunks(grants, 500)) {
    const { data, error } = await db.from("user_rewards")
      .upsert(c, { onConflict: "user_id,reward_id,subject_key", ignoreDuplicates: true })
      .select("reward_id");
    if (error) throw new Error(`writing grants: ${error.message}`);
    inserted += data?.length ?? 0;
  }
  return inserted;
}

function logRuleErrors(errors: RuleLoadError[]): void {
  for (const e of errors) console.warn(`rules: skipping malformed rule ${e.rule_id}: ${e.error}`);
}

async function evaluateUsers(
  db: SupabaseClient,
  userIds: readonly string[],
  rules: readonly ParsedRule[],
  now: Date,
  albumCache: AlbumCache,
): Promise<number> {
  const aggs = await loadAggregates(db, userIds, needsOf(rules), albumCache);
  const grants: Grant[] = [];
  for (const [userId, agg] of aggs) grants.push(...decideGrants(userId, rules, agg, now));
  return grants.length ? await writeGrants(db, grants) : 0;
}

/**
 * Evaluate every active rule for one user and write any new grants.
 * Called by lastfm-sync after each sync. Idempotent; never revokes.
 */
export async function evaluateUser(
  db: SupabaseClient,
  userId: string,
): Promise<{ granted: number }> {
  const now = new Date();
  const { rules, errors } = await loadRules(db);
  logRuleErrors(errors);
  const live = rules.filter((r) => isLive(r, now));
  if (live.length === 0) return { granted: 0 };
  return { granted: await evaluateUsers(db, [userId], live, now, new Map()) };
}

export class RuleNotFoundError extends Error {}

export interface EvaluateResult {
  evaluated_users: number;
  granted: number;
  /** Rules that were skipped because they are malformed. */
  skipped_rules: RuleLoadError[];
}

/**
 * The `rules-evaluate` operation. With `ruleId`, only that rule; with `userId`,
 * only that user; with neither, every active rule for every user.
 *
 * The all-users path pages through users `pageSize` at a time, loading only
 * that page's aggregates, so memory does not grow with the user base.
 *
 * A single `ruleId` that is malformed throws RuleValidationError (the caller
 * asked for exactly that rule, so it should hear why nothing happened).
 */
export async function evaluate(
  db: SupabaseClient,
  opts: { ruleId?: string; userId?: string; pageSize?: number; now?: Date } = {},
): Promise<EvaluateResult> {
  const now = opts.now ?? new Date();
  const { rules, errors, found } = await loadRules(db, { ruleId: opts.ruleId });
  if (opts.ruleId && found === 0) throw new RuleNotFoundError(`No rule with id ${opts.ruleId}.`);
  if (opts.ruleId && errors.length) throw new RuleValidationError(errors[0].error);
  logRuleErrors(errors);
  const live = rules.filter((r) => isLive(r, now));
  const result: EvaluateResult = { evaluated_users: 0, granted: 0, skipped_rules: errors };
  if (live.length === 0) return result;

  const albumCache: AlbumCache = new Map();
  const pages = opts.userId ? [[opts.userId]] : userPages(db, opts.pageSize ?? 100);
  for await (const ids of pages) {
    result.granted += await evaluateUsers(db, ids, live, now, albumCache);
    result.evaluated_users += ids.length;
  }
  return result;
}
