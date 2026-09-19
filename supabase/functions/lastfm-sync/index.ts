/**
 * lastfm-sync (docs/REWARDS.md section 9).
 *
 * Signed-in user, POST {} ->
 *   { done, pages_processed, plays_added, granted }
 *
 * Syncs ONLY the caller's own, VERIFIED Last.fm account (ownership proven by
 * lastfm-auth-complete). Resumable: each call walks a bounded chunk and returns
 * done: false until the walk is complete; callers keep calling until done.
 * The exactness argument is in _shared/lastfm/sync.ts.
 *
 * Extra response field, beyond the contract: `busy: true` when another sync
 * call for the same account is still running (done is false; call again).
 */

import { evaluateUser } from "../_shared/rules/evaluate.ts";
import { callerId, CORS_HEADERS, env, json, serviceClient } from "../_shared/lastfm/http.ts";
import { lastfmFetcher, runChunk } from "../_shared/lastfm/sync.ts";
import { backfillArtistNameKeys, postgresStore, recomputeArtistPlays } from "../_shared/lastfm/store.ts";

/** Well inside the Edge Function wall clock, leaving room for recompute + evaluate. */
const BUDGET_MS = 45_000;
const MAX_PAGES = 30;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const db = serviceClient();
    const userId = await callerId(req, db);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const { data: account, error } = await db
      .from("linked_accounts")
      .select("id, external_id, verified_at")
      .eq("user_id", userId)
      .eq("provider", "lastfm")
      .not("verified_at", "is", null)
      .maybeSingle();
    if (error) throw new Error(`linked_accounts: ${error.message}`);
    if (!account) return json({ error: "no_verified_lastfm_account" }, 409);

    const chunk = await runChunk({
      store: postgresStore(db, account.id, userId),
      fetchPage: lastfmFetcher(account.external_id, env("LASTFM_API_KEY")),
      maxPages: MAX_PAGES,
      budgetMs: BUDGET_MS,
    });

    let granted = 0;
    // Re-deriving artist_plays costs ~5s on a full history (138k rows here), so
    // skip it for a chunk that changed nothing. A finished sync always
    // recomputes, which also picks up catalog artists seeded since last time
    // (a newly seeded MBID can consolidate a 'name:' artist).
    if (!chunk.busy && (chunk.playsAdded > 0 || chunk.done)) {
      await backfillArtistNameKeys(db);
      await recomputeArtistPlays(db, userId);
      granted = (await evaluateUser(db, userId)).granted;
    }

    return json({
      done: chunk.done,
      pages_processed: chunk.pagesProcessed,
      plays_added: chunk.playsAdded,
      granted,
      ...(chunk.busy ? { busy: true } : {}),
    });
  } catch (e) {
    console.error("lastfm-sync", e);
    return json({ error: "server_error" }, 500);
  }
});
