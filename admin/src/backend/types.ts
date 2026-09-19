import type {
  Album,
  Artist,
  DryRunResult,
  DryRunRule,
  EvaluateResult,
  Reward,
  RewardDraft,
  Rule,
  RuleDraft,
  Session,
} from '../types';

/**
 * Everything the dashboard reads and writes. Two implementations:
 *  - `live`: Supabase with the publishable key and the signed-in admin's session.
 *    RLS decides what is allowed; nothing here tries to get around it.
 *  - `demo`: an in-memory stand-in with a fake admin, for developing the UI.
 */
export interface Backend {
  mode: 'live' | 'demo';
  getSession(): Promise<Session | null>;
  onAuthChange(cb: (s: Session | null) => void): () => void;
  signInWithPassword(email: string, password: string): Promise<void>;
  /** Sends an email. Only ever called from an explicit click by the person signing in. */
  sendMagicLink(email: string): Promise<void>;
  signOut(): Promise<void>;
  isAdmin(): Promise<boolean>;

  listRules(): Promise<Rule[]>;
  createRule(d: RuleDraft, by: string): Promise<Rule>;
  updateRule(id: string, d: Partial<RuleDraft>, by: string): Promise<Rule>;

  listRewards(): Promise<Reward[]>;
  createReward(d: RewardDraft): Promise<Reward>;
  updateReward(id: string, d: RewardDraft): Promise<Reward>;
  uploadArt(file: File): Promise<string>;

  searchArtists(q: string): Promise<Artist[]>;
  searchAlbums(q: string): Promise<Album[]>;
  artistsByMbid(keys: string[]): Promise<Artist[]>;
  artistsById(ids: string[]): Promise<Artist[]>;
  albumsByMbid(keys: string[]): Promise<Album[]>;
  albumsById(ids: string[]): Promise<Album[]>;
  /** Add an artist picked from MusicBrainz to the catalog, so rules can name it. */
  ensureArtist(mbid: string, name: string): Promise<Artist>;
  /** A slice of the catalog, only used by the MOCK dry run to invent plausible subjects. */
  catalogSample(kind: 'artist' | 'album', limit: number): Promise<{ key: string; name: string }[]>;
}

/** The two Edge Functions from section 9. */
export interface RuleFunctions {
  mode: 'live' | 'mock';
  dryRun(rule: DryRunRule): Promise<DryRunResult>;
  evaluate(args: { rule_id?: string; user_id?: string }): Promise<EvaluateResult>;
}
