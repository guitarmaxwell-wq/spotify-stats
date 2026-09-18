/**
 * Spotify Extended Streaming History import — the only real Spotify backfill.
 *
 * This is the one path that can hand a user a full shelf from Spotify data, and
 * it is not an API. The user requests it at spotify.com → Account → Privacy →
 * "Extended streaming history", waits (officially up to 30 days, in practice
 * 1–5), downloads a zip, and picks the JSON files out of it. Nothing about that
 * can be automated, which is why it is a power-user importer and never the
 * onboarding flow.
 *
 * It is, however, the best data available anywhere, because it carries
 * `ms_played`. Last.fm scrobbles have no duration at all.
 *
 * Users routinely request the wrong export, so both shapes are read:
 *  - `Streaming_History_Audio_*.json` — all-time, `ts` / `master_metadata_*` /
 *    `ms_played`. This is the right one.
 *  - `StreamingHistory*.json` — the "Account data" request, **last 12 months
 *    only**, `endTime` / `artistName` / `trackName` / `msPlayed`.
 * The second is detected and called out, because someone who waited three weeks
 * for the wrong zip should be told, not shown a thin shelf.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

import { cleanArtist, cleanTitle } from './normalize';
import { type PlayEvent, type SyncResult, emptyResult } from './types';

export const EXTENDED_PREFIX = 'Streaming_History_Audio';
export const ACCOUNT_PREFIX = 'StreamingHistory';

/**
 * A play counts toward unlocking when at least this much of it was played.
 * See `ingest/README.md` for the reasoning; the value lives in both places
 * because both can build album groups.
 */
export const DEFAULT_MIN_MS_PLAYED = 30_000;

/** Tracks shorter than the threshold unlock at half their length instead. */
export const SHORT_TRACK_FRACTION = 0.5;

export function countsAsListen(ev: PlayEvent, minMs = DEFAULT_MIN_MS_PLAYED): boolean {
  // Sources with no ms_played always count: Last.fm has already applied its own
  // scrobble threshold upstream, and second-guessing it with no duration data
  // would just be inventing a rule.
  if (ev.ms_played == null) return true;
  if (ev.ms_played >= minMs) return true;
  if (ev.duration_ms && ev.duration_ms < minMs) {
    return ev.ms_played >= ev.duration_ms * SHORT_TRACK_FRACTION;
  }
  return false;
}

function parseTs(value: unknown): number {
  if (!value) throw new Error('missing timestamp');
  let s = String(value).trim();
  // The account-data format uses "2021-05-03 17:20" with no zone. Reading it as
  // UTC is what every other tool does; the error is bounded by the user's offset.
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`unparseable timestamp: ${value}`);
  return Math.floor(ms / 1000);
}

/**
 * One export row -> PlayEvent, or null if it is not a music play.
 *
 * Podcast and audiobook rows have a null `master_metadata_track_name`. They are
 * real plays but they are not album tracks, so they are skipped rather than
 * counted as errors.
 */
export function parseRow(row: any): PlayEvent | null {
  if (!row || typeof row !== 'object') throw new Error('not an object');

  const track = row.master_metadata_track_name;
  const artist = row.master_metadata_album_artist_name;
  if (track !== undefined || artist !== undefined) {
    if (!track || !artist) return null; // podcast / episode / unnamed local file
    return {
      ts: parseTs(row.ts),
      artist: cleanArtist(artist),
      track: cleanTitle(track),
      album: row.master_metadata_album_album_name
        ? cleanTitle(row.master_metadata_album_album_name)
        : null,
      source: 'spotify_export',
      ms_played: typeof row.ms_played === 'number' ? row.ms_played : null,
      foreign_id: row.spotify_track_uri ?? null,
    };
  }

  if (row.trackName !== undefined || row.artistName !== undefined) {
    if (!row.trackName || !row.artistName) return null;
    return {
      ts: parseTs(row.endTime),
      artist: cleanArtist(row.artistName),
      track: cleanTitle(row.trackName),
      album: null, // this format has no album field at all
      source: 'spotify_export',
      ms_played: typeof row.msPlayed === 'number' ? row.msPlayed : null,
    };
  }

  if (row.episode_name || row.audiobook_title) return null;
  throw new Error('unrecognised export row shape');
}

export interface ParsedFile {
  name: string;
  events: PlayEvent[];
  invalid: number;
  skipped: number;
  looksLikeAccountData: boolean;
}

export function parseFileContents(name: string, contents: string): ParsedFile {
  const blob = JSON.parse(contents);
  if (!Array.isArray(blob)) throw new Error(`${name}: expected a JSON array`);

  const events: PlayEvent[] = [];
  let invalid = 0;
  let skipped = 0;
  for (const row of blob) {
    try {
      const ev = parseRow(row);
      if (ev) events.push(ev);
      else skipped += 1;
    } catch {
      invalid += 1;
    }
  }
  return {
    name,
    events,
    invalid,
    skipped,
    looksLikeAccountData: name.startsWith(ACCOUNT_PREFIX) && !name.startsWith(EXTENDED_PREFIX),
  };
}

export const ACCOUNT_DATA_WARNING =
  'Those files look like the “Account data” export, which only covers the last ' +
  '12 months. The full backfill needs the separate “Extended streaming history” ' +
  'request from spotify.com → Account → Privacy.';

export const NOTHING_RECOGNISED =
  'None of those files looked like Spotify streaming history. Look for files ' +
  `named ${EXTENDED_PREFIX}_*.json inside the zip Spotify sent you.`;

export interface ImportOptions {
  persist: (events: PlayEvent[]) => Promise<{ added: number; duplicates: number }>;
  onFile?: (name: string, index: number, total: number) => void;
}

/**
 * Let the user pick history files and fold them into the store.
 *
 * Files are read and persisted one at a time. An export can be a dozen 12MB
 * JSON files; parsing them all before writing anything would hold the whole
 * history in memory at once and get the app killed on an older phone.
 */
export async function pickAndImport(opts: ImportOptions): Promise<SyncResult | null> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/json', '*/*'],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (picked.canceled) return null;

  const assets = picked.assets ?? [];
  const result = emptyResult('spotify_export');
  let recognised = 0;
  let sawAccountData = false;

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    opts.onFile?.(asset.name, i + 1, assets.length);
    if (!asset.name.toLowerCase().endsWith('.json')) {
      result.warnings.push(`Skipped ${asset.name} — not a .json file.`);
      continue;
    }
    let parsed: ParsedFile;
    try {
      const contents = await new File(asset.uri).text();
      parsed = parseFileContents(asset.name, contents);
    } catch (e) {
      result.warnings.push(`Could not read ${asset.name}: ${e instanceof Error ? e.message : e}`);
      continue;
    }

    recognised += 1;
    if (parsed.looksLikeAccountData) sawAccountData = true;
    const { added, duplicates } = await opts.persist(parsed.events);
    result.fetched += parsed.events.length;
    result.added += added;
    result.duplicates += duplicates;
    result.invalid += parsed.invalid;
    result.skipped += parsed.skipped;
  }

  if (!recognised) result.warnings.push(NOTHING_RECOGNISED);
  if (sawAccountData) result.warnings.push(ACCOUNT_DATA_WARNING);
  return result;
}
