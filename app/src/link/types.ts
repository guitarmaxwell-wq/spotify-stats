/**
 * TypeScript mirror of the play-event schema in `ingest/schema.py`.
 *
 * The two must agree on field names, because the app uploads/exports events
 * that the Python side reads back. They deliberately do NOT agree on
 * normalization depth — see `normalize.ts` for why.
 */

export type SourceId = 'lastfm' | 'lastfm_csv' | 'spotify_recent' | 'spotify_export';

export const SOURCES: SourceId[] = ['lastfm', 'lastfm_csv', 'spotify_recent', 'spotify_export'];

/**
 * Does this source's timestamp mark the start or the end of the play?
 * Last.fm stamps the start; both Spotify sources stamp the end. That is a
 * whole track-length of skew between two records of the same play.
 */
export const TS_KIND: Record<SourceId, 'start' | 'end'> = {
  lastfm: 'start',
  lastfm_csv: 'start',
  spotify_recent: 'end',
  spotify_export: 'end',
};

/** One play of one track, from any source. `ts` is Unix **seconds**, UTC. */
export interface PlayEvent {
  ts: number;
  artist: string;
  track: string;
  source: SourceId;
  album?: string | null;
  /** Only ever present on `spotify_export`. Never infer one. */
  ms_played?: number | null;
  duration_ms?: number | null;
  artist_mbid?: string | null;
  album_mbid?: string | null;
  track_mbid?: string | null;
  foreign_id?: string | null;
}

/** A source's high-water mark. Mirrors `ingest.store.Cursor`. */
export interface Cursor {
  source: SourceId;
  last_ts: number;
  last_synced_at: number;
  total_added: number;
  /** Polls that came back full, meaning plays may have been lost. */
  suspected_gaps: number;
}

export function emptyCursor(source: SourceId): Cursor {
  return { source, last_ts: 0, last_synced_at: 0, total_added: 0, suspected_gaps: 0 };
}

/** Spotify wants Unix ms; Last.fm wants Unix seconds. Keep both honest. */
export const afterMs = (c: Cursor): number => (c.last_ts ? c.last_ts * 1000 : 0);
export const fromUts = (c: Cursor): number => (c.last_ts ? c.last_ts + 1 : 0);

export interface SyncResult {
  source: SourceId;
  fetched: number;
  added: number;
  duplicates: number;
  invalid: number;
  skipped: number;
  warnings: string[];
}

export function emptyResult(source: SourceId): SyncResult {
  return { source, fetched: 0, added: 0, duplicates: 0, invalid: 0, skipped: 0, warnings: [] };
}

/** Which sources the user has connected, for the linking screen. */
export interface LinkState {
  lastfmUsername: string | null;
  spotifyLinked: boolean;
  spotifyExpiresAt: number | null;
  cursors: Partial<Record<SourceId, Cursor>>;
  totalPlays: number;
}
