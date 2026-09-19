// Data loading for the rule engine. All database READS live here; the decision
// logic (decide.ts) never sees a client. `db` is a service-role client.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { parseRule, RuleValidationError } from "./validate.ts";
import type { AlbumAggregate, ParsedRule, RewardRow, RuleRow, UserAggregates } from "./types.ts";

/** Rows per PostgREST request. Paging stops on an EMPTY page, not a short one,
 * so a server `max_rows` below this can only cost a request, never truncate. */
const PAGE = 1000;
/** Ids per `.in(...)` filter, to keep request URLs short. */
const IN_CHUNK = 100;

type Resp<T> = { data: T[] | null; error: { message: string } | null };

export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<Resp<T>>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0;;) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return out;
    out.push(...data);
    from += data.length; // not PAGE: the server may have capped the page
  }
}

export function chunks<T>(xs: readonly T[], n = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export interface RuleLoadError {
  rule_id: string;
  error: string;
}

export const REWARD_COLS = "id, kind, subject_kind, artist_id, album_id";
const RULE_COLS = "id, type, params, reward_id, active, starts_at, ends_at";

export async function loadRewards(db: SupabaseClient, ids: readonly string[]): Promise<Map<string, RewardRow>> {
  const out = new Map<string, RewardRow>();
  for (const c of chunks([...new Set(ids)])) {
    const { data, error } = await db.from("rewards").select(REWARD_COLS).in("id", c);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as RewardRow[]) out.set(r.id, r);
  }
  return out;
}

/**
 * Load and validate rules. With `ruleId`, just that rule (whatever its
 * `active`); otherwise every ACTIVE rule. Ordered oldest first, so when two
 * rules grant the same (reward, subject) the older one is recorded as the cause.
 * Malformed rules are returned in `errors`, not thrown, so one bad row cannot
 * stop every other rule from granting.
 */
export async function loadRules(
  db: SupabaseClient,
  opts: { ruleId?: string } = {},
): Promise<{ rules: ParsedRule[]; errors: RuleLoadError[]; found: number }> {
  const rows = await fetchAll<RuleRow>((from, to) => {
    let q = db.from("rules").select(RULE_COLS);
    q = opts.ruleId ? q.eq("id", opts.ruleId) : q.eq("active", true);
    return q.order("created_at").order("id").range(from, to) as unknown as PromiseLike<Resp<RuleRow>>;
  });
  const rewards = await loadRewards(db, rows.map((r) => r.reward_id));
  const rules: ParsedRule[] = [];
  const errors: RuleLoadError[] = [];
  for (const row of rows) {
    try {
      rules.push(parseRule(row, rewards.get(row.reward_id)));
    } catch (e) {
      if (!(e instanceof RuleValidationError)) throw e;
      errors.push({ rule_id: row.id, error: e.message });
    }
  }
  return { rules, errors, found: rows.length };
}

/** What the given rules need loaded, so nothing else is fetched. */
export interface Needs {
  /** Load artist_plays with plays >= this; null = do not load artist_plays. */
  artistMin: number | null;
  /** If set, only these artist keys matter (no artist_plays wildcard rule). */
  artistKeys: string[] | null;
  /** Load track_plays and album tracklists. */
  albums: boolean;
}

export function needsOf(rules: readonly { params: ParsedRule["params"] }[]): Needs {
  let artistMin: number | null = null;
  let artistKeys: Set<string> | null = new Set();
  let albums = false;
  for (const { params: p } of rules) {
    if (p.type === "artist_plays") {
      artistMin = artistMin === null ? p.threshold : Math.min(artistMin, p.threshold);
      if (p.artist === "*") artistKeys = null;
      else artistKeys?.add(p.artist);
    } else {
      albums = true;
    }
  }
  return { artistMin, artistKeys: artistKeys && artistMin !== null ? [...artistKeys] : null, albums };
}

interface ArtistPlayRow { user_id: string; plays: number; artists: { mbid: string } }
interface TrackPlayRow { user_id: string; album_id: string; track_key: string; plays: number }
interface AlbumRow { id: string; release_mbid: string; tracklist: unknown; artists: { mbid: string } | null }

/** Album catalog rows, cached across user pages within one run. */
export type AlbumCache = Map<string, { key: string; artistKey: string | null; tracklist: string[] }>;

async function fillAlbumCache(db: SupabaseClient, ids: Iterable<string>, cache: AlbumCache): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => !cache.has(id));
  for (const c of chunks(missing)) {
    const { data, error } = await db.from("albums")
      .select("id, release_mbid, tracklist, artists(mbid)")
      .in("id", c);
    if (error) throw new Error(error.message);
    for (const a of (data ?? []) as unknown as AlbumRow[]) {
      const tracklist = Array.isArray(a.tracklist) ? a.tracklist.filter((t): t is string => typeof t === "string") : [];
      cache.set(a.id, { key: a.release_mbid, artistKey: a.artists?.mbid ?? null, tracklist });
    }
  }
}

/**
 * Aggregates for a batch of users. Memory is proportional to the batch, not to
 * the user base: the all-users path calls this one page of users at a time.
 */
export async function loadAggregates(
  db: SupabaseClient,
  userIds: readonly string[],
  needs: Needs,
  albumCache: AlbumCache = new Map(),
): Promise<Map<string, UserAggregates>> {
  const out = new Map<string, UserAggregates>();
  for (const u of userIds) out.set(u, { artistPlays: new Map(), albums: [] });
  if (userIds.length === 0) return out;

  if (needs.artistMin !== null && (needs.artistKeys === null || needs.artistKeys.length > 0)) {
    for (const keyChunk of needs.artistKeys === null ? [null] : chunks(needs.artistKeys)) {
      const rows = await fetchAll<ArtistPlayRow>((from, to) => {
        let q = db.from("artist_plays")
          .select("user_id, plays, artists!inner(mbid)")
          .in("user_id", userIds as string[])
          .gte("plays", needs.artistMin!);
        if (keyChunk) q = q.in("artists.mbid", keyChunk);
        return q.order("user_id").order("artist_id").range(from, to) as unknown as PromiseLike<Resp<ArtistPlayRow>>;
      });
      for (const r of rows) out.get(r.user_id)?.artistPlays.set(r.artists.mbid, r.plays);
    }
  }

  if (needs.albums) {
    const rows = await fetchAll<TrackPlayRow>((from, to) =>
      db.from("track_plays")
        .select("user_id, album_id, track_key, plays")
        .in("user_id", userIds as string[])
        .order("user_id").order("album_id").order("track_key")
        .range(from, to) as unknown as PromiseLike<Resp<TrackPlayRow>>
    );
    await fillAlbumCache(db, rows.map((r) => r.album_id), albumCache);
    const perUser = new Map<string, Map<string, AlbumAggregate>>();
    for (const r of rows) {
      const album = albumCache.get(r.album_id);
      if (!album) continue;
      let byAlbum = perUser.get(r.user_id);
      if (!byAlbum) perUser.set(r.user_id, byAlbum = new Map());
      let agg = byAlbum.get(r.album_id);
      if (!agg) byAlbum.set(r.album_id, agg = { ...album, trackPlays: new Map() });
      agg.trackPlays.set(r.track_key, r.plays);
    }
    for (const [u, byAlbum] of perUser) out.get(u)!.albums = [...byAlbum.values()];
  }
  return out;
}

/** Page through every user id (from `profiles`, one row per auth user). */
export async function* userPages(db: SupabaseClient, size = 100): AsyncGenerator<string[]> {
  let after: string | null = null;
  for (;;) {
    let q = db.from("profiles").select("id").order("id").limit(size);
    if (after) q = q.gt("id", after);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) return;
    yield ids;
    after = ids[ids.length - 1];
  }
}
