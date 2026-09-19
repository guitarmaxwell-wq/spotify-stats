/**
 * Postgres-backed SyncStore and the catalog helpers the sync needs.
 *
 * `db` must be a SERVICE-ROLE client: every function here is revoked from the
 * client roles (migration 20260919040000_lastfm_sync.sql).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { artistKey } from "./normalize.ts";
import { type BeginResult, LOOKBACK_S, type SyncStore } from "./sync.ts";

export const LEASE_S = 120;
export const MIN_SYNC_INTERVAL_S = 60;

export function postgresStore(db: SupabaseClient, accountId: string, userId: string): SyncStore {
  return {
    async begin(): Promise<BeginResult> {
      const { data, error } = await db.rpc("lastfm_begin_sync", {
        p_account: accountId,
        p_user: userId,
        p_lookback_s: LOOKBACK_S,
        p_lease_s: LEASE_S,
        p_min_interval_s: MIN_SYNC_INTERVAL_S,
      });
      if (error) throw new Error(`lastfm_begin_sync: ${error.message}`);
      const r = (Array.isArray(data) ? data[0] : data) as any;
      if (r?.status === "busy") return { status: "busy" };
      if (r?.status === "idle_recent") return { status: "idle_recent" };
      if (r?.status !== "ok") throw new Error(`lastfm_begin_sync: unexpected ${JSON.stringify(r)}`);
      return {
        status: "ok",
        window: {
          from: r.sync_from == null ? null : Number(r.sync_from),
          to: Number(r.sync_to),
          walkTo: Number(r.walk_to),
          walkPage: Number(r.walk_page),
        },
      };
    },
    async ingest(expect, rows, step) {
      const { data, error } = await db.rpc("lastfm_ingest_page", {
        p_account: accountId,
        p_user: userId,
        p_expect_to: expect.walkTo,
        p_expect_page: expect.walkPage,
        p_plays: rows,
        p_next_to: step.nextTo,
        p_next_page: step.nextPage,
        p_done: step.done,
      });
      if (error) throw new Error(`lastfm_ingest_page: ${error.message}`);
      const r = (Array.isArray(data) ? data[0] : data) as any;
      return { applied: !!r?.applied, inserted: Number(r?.inserted ?? 0) };
    },
    async release() {
      const { error } = await db.rpc("lastfm_release_sync", { p_account: accountId });
      if (error) console.error("lastfm_release_sync", error.message);
    },
  };
}

/**
 * Give every catalog artist with a real MBID its artistKey, so a scrobble
 * WITHOUT an MBID can be resolved to it by name. The normalizer lives in
 * TypeScript, so this cannot be a SQL trigger; it runs before each recompute
 * and covers artists inserted by anyone (seed scripts, the admin dashboard).
 * Returns how many keys were added.
 */
export async function backfillArtistNameKeys(db: SupabaseClient, maxRounds = 5): Promise<number> {
  let added = 0;
  // PostgREST caps a response at max_rows (1000), so work in rounds. Each round
  // asks only for artists that still have NO key (an anti-join), so it makes
  // progress; the round cap bounds the work per sync call.
  for (let round = 0; round < maxRounds; round++) {
    const { data, error } = await db
      .from("artists")
      .select("id, name, artist_name_keys!left(artist_id)")
      .not("mbid", "like", "name:%")
      .is("artist_name_keys", null)
      .limit(1000);
    if (error) throw new Error(`artists without name keys: ${error.message}`);
    const rows = (data ?? [])
      .map((a: any) => ({ artist_id: a.id as string, name_key: artistKey(a.name) }))
      .filter((r) => r.name_key);
    if (!rows.length) break;
    const { error: e2 } = await db
      .from("artist_name_keys")
      .upsert(rows, { onConflict: "artist_id,name_key", ignoreDuplicates: true });
    if (e2) throw new Error(`artist_name_keys upsert: ${e2.message}`);
    added += rows.length;
    if ((data ?? []).length < 1000) break;
  }
  return added;
}

export async function recomputeArtistPlays(db: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await db.rpc("lastfm_recompute_artist_plays", { p_user: userId });
  if (error) throw new Error(`lastfm_recompute_artist_plays: ${error.message}`);
  return Number(data ?? 0);
}
