import { createClient, FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js';
import type { Album, DryRunResult, DryRunRule, EvaluateResult, Reward, RewardDraft, Rule, RuleDraft, Session } from '../types';
import type { Backend, RuleFunctions } from './types';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const liveConfigured = Boolean(url && key);

let client: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (!client) {
    if (!url || !key) throw new Error('admin/.env is missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.');
    client = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'milk-admin-auth' },
    });
  }
  return client;
}

function toSession(s: { user: { id: string; email?: string | null } } | null): Session | null {
  return s ? { userId: s.user.id, email: s.user.email ?? null } : null;
}

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

const ALBUM_COLS = 'id, release_mbid, artist_id, title, tracklist, artists(name)';
type AlbumRow = {
  id: string;
  release_mbid: string;
  artist_id: string | null;
  title: string;
  tracklist: unknown[];
  artists: { name: string } | { name: string }[] | null;
};
function toAlbum(r: AlbumRow): Album {
  const a = Array.isArray(r.artists) ? r.artists[0] : r.artists;
  return {
    id: r.id,
    release_mbid: r.release_mbid,
    artist_id: r.artist_id,
    title: r.title,
    artist_name: a?.name ?? null,
    track_count: Array.isArray(r.tracklist) ? r.tracklist.length : 0,
  };
}

/** Escape PostgREST ilike wildcards in user input. */
function like(q: string): string {
  return `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
}

export const liveBackend: Backend = {
  mode: 'live',
  async getSession() {
    const { data } = await sb().auth.getSession();
    return toSession(data.session);
  },
  onAuthChange(cb) {
    const { data } = sb().auth.onAuthStateChange((_e, s) => cb(toSession(s)));
    return () => data.subscription.unsubscribe();
  },
  async signInWithPassword(email, password) {
    const { error } = await sb().auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  },
  async sendMagicLink(email) {
    const { error } = await sb().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    if (error) throw new Error(error.message);
  },
  async signOut() {
    await sb().auth.signOut();
  },
  async isAdmin() {
    // `admins` has no client policies, so it cannot be read directly. is_admin()
    // is SECURITY DEFINER and answers only for the caller.
    return Boolean(check(await sb().rpc('is_admin')));
  },

  async listRules() {
    return check(await sb().from('rules').select('*').order('updated_at', { ascending: false })) as Rule[];
  },
  async createRule(d: RuleDraft, by: string) {
    return check(await sb().from('rules').insert({ ...d, updated_by: by }).select('*').single()) as Rule;
  },
  async updateRule(id, d, by) {
    // RLS: a non-admin's update matches zero rows rather than erroring, so demand one back.
    const res = await sb().from('rules').update({ ...d, updated_by: by }).eq('id', id).select('*');
    const rows = check(res) as Rule[];
    if (!rows.length) throw new Error('Nothing was updated. Is this account still an admin?');
    return rows[0];
  },

  async listRewards() {
    return check(await sb().from('rewards').select('*').order('created_at', { ascending: false })) as Reward[];
  },
  async createReward(d: RewardDraft) {
    return check(await sb().from('rewards').insert(d).select('*').single()) as Reward;
  },
  async updateReward(id, d) {
    const rows = check(await sb().from('rewards').update(d).eq('id', id).select('*')) as Reward[];
    if (!rows.length) throw new Error('Nothing was updated. Is this account still an admin?');
    return rows[0];
  },
  async uploadArt(file: File) {
    const safe = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-');
    const path = `${crypto.randomUUID()}-${safe}`;
    const { error } = await sb().storage.from('reward-art').upload(path, file, {
      contentType: file.type || undefined,
      upsert: false,
    });
    if (error) throw new Error(error.message);
    return sb().storage.from('reward-art').getPublicUrl(path).data.publicUrl;
  },

  async searchArtists(q) {
    if (!q.trim()) return [];
    return check(await sb().from('artists').select('id, mbid, name').ilike('name', like(q.trim())).order('name').limit(8)) as never;
  },
  async searchAlbums(q) {
    if (!q.trim()) return [];
    const rows = check(await sb().from('albums').select(ALBUM_COLS).ilike('title', like(q.trim())).order('title').limit(8)) as AlbumRow[];
    return rows.map(toAlbum);
  },
  async artistsByMbid(keys) {
    if (!keys.length) return [];
    return check(await sb().from('artists').select('id, mbid, name').in('mbid', keys)) as never;
  },
  async artistsById(ids) {
    if (!ids.length) return [];
    return check(await sb().from('artists').select('id, mbid, name').in('id', ids)) as never;
  },
  async albumsByMbid(keys) {
    if (!keys.length) return [];
    return (check(await sb().from('albums').select(ALBUM_COLS).in('release_mbid', keys)) as AlbumRow[]).map(toAlbum);
  },
  async albumsById(ids) {
    if (!ids.length) return [];
    return (check(await sb().from('albums').select(ALBUM_COLS).in('id', ids)) as AlbumRow[]).map(toAlbum);
  },
  async ensureArtist(mbid, name) {
    const existing = check(await sb().from('artists').select('id, mbid, name').eq('mbid', mbid).maybeSingle());
    if (existing) return existing as never;
    return check(await sb().from('artists').insert({ mbid, name }).select('id, mbid, name').single()) as never;
  },
  async catalogSample(kind, limit) {
    if (kind === 'artist') {
      const rows = check(await sb().from('artists').select('mbid, name').limit(limit)) as { mbid: string; name: string }[];
      return rows.map((r) => ({ key: r.mbid, name: r.name }));
    }
    const rows = check(await sb().from('albums').select('release_mbid, title').limit(limit)) as { release_mbid: string; title: string }[];
    return rows.map((r) => ({ key: r.release_mbid, name: r.title }));
  },
};

/**
 * A failed Edge Function call. Section 9: the body is { "error": string }, written
 * for a human, so `message` is shown verbatim. 401 = no/expired session,
 * 403 = not an admin, 400 = malformed rule, 404 = unknown rule_id (or, from the
 * gateway, a function that is not deployed).
 */
export class FnError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb().functions.invoke(name, { body });
  if (!error) return data as T;
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response;
    let detail = '';
    try {
      const j = await res.clone().json();
      detail = typeof j.error === 'string' ? j.error : (j.message ?? JSON.stringify(j));
    } catch {
      detail = await res.text().catch(() => '');
    }
    if (res.status === 404 && !detail.length) detail = `${name} is not deployed. Switch Functions to Mock in the header, or deploy it.`;
    throw new FnError(res.status, detail || `${name} failed (${res.status} ${res.statusText}).`);
  }
  throw new FnError(0, `${name} could not be reached: ${error.message}`);
}

export const liveFunctions: RuleFunctions = {
  mode: 'live',
  dryRun: (rule: DryRunRule) => invoke<DryRunResult>('rules-dry-run', { rule }),
  evaluate: (args) => invoke<EvaluateResult>('rules-evaluate', args),
};
