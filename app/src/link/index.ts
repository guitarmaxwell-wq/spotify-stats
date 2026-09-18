/**
 * Linking: three paths into one play store.
 *
 * They are not interchangeable and the UI must not pretend they are:
 *
 *  - `lastfm`         full history from a username. The only scalable path.
 *  - `spotify_recent` forward-only. Cannot see a single play from before linking.
 *  - `spotify_export` full Spotify history, but only via a manual GDPR download.
 *
 * See `ingest/README.md` for the limits behind each of those sentences.
 */

export * as lastfm from './lastfm';
export * as spotify from './spotify';
export * as spotifyImport from './spotifyImport';
export * from './config';
export * from './playStore';
export * from './tokens';
export * from './types';
export { artistKey, cleanArtist, cleanTitle, identity, matchKey } from './normalize';
