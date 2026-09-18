import type { Album, Collection, Crate } from '../types';
import real from './collection.json';

/**
 * Single entry point for collection data.
 *
 * `collection.json` is the pipeline's output, copied in from `data/` by
 * `npm run sync-data`. Swap back to `./mockCollection.json` to work offline.
 */
const SOURCE = real as unknown as Collection;

export function loadCollection(): Collection {
  return { ...SOURCE, albums: dedupeById(SOURCE.albums) };
}

/**
 * Safety net: the contract says `albums[].id` is unique, but a release reached
 * through two different scrobble spellings has escaped that before, leaving the
 * same record both earned and not earned. Merging is the pipeline's job — here
 * we only keep the furthest-along row so the UI never renders one record twice
 * or drops it to a duplicate React key.
 */
function dedupeById(albums: Album[]): Album[] {
  const best = new Map<string, Album>();
  for (const album of albums) {
    const seen = best.get(album.id);
    if (!seen || album.played_tracks > seen.played_tracks) best.set(album.id, album);
  }
  return albums.length === best.size ? albums : [...best.values()];
}

/** Genres, each with its albums, unlocked-first then most complete. */
export function buildCrates(collection: Collection): Crate[] {
  // A record is only in the crate once every track on it has been played.
  // In-progress albums live on the "Almost there" screen, not the shelf.
  const byGenre = new Map<string, Album[]>();
  for (const album of collection.albums.filter((a) => a.unlocked)) {
    const list = byGenre.get(album.genre_id);
    if (list) list.push(album);
    else byGenre.set(album.genre_id, [album]);
  }

  const known = new Set(collection.genres.map((g) => g.id));
  // Genres present on albums but absent from `genres` still get a crate; the
  // spec does not promise the two lists agree.
  const genres = [
    ...collection.genres,
    ...[...byGenre.keys()]
      .filter((id) => !known.has(id))
      .map((id) => ({ id, label: id, album_count: byGenre.get(id)!.length })),
  ];

  return genres
    .map((genre) => {
      const albums = (byGenre.get(genre.id) ?? []).slice().sort(compareAlbums);
      return {
        genre,
        albums,
        unlockedCount: albums.filter((a) => a.unlocked).length,
      };
    })
    .filter((crate) => crate.albums.length > 0)
    .sort((a, b) => b.albums.length - a.albums.length);
}

function compareAlbums(a: Album, b: Album): number {
  if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
  if (b.completion !== a.completion) return b.completion - a.completion;
  return b.play_count - a.play_count;
}

/** Albums that are close but not unlocked — the "go listen to this" list. */
export function almostThere(collection: Collection): Album[] {
  return collection.albums
    .filter((a) => !a.unlocked && a.played_tracks > 0)
    .sort((a, b) => {
      const missA = a.total_tracks - a.played_tracks;
      const missB = b.total_tracks - b.played_tracks;
      if (missA !== missB) return missA - missB;
      return b.completion - a.completion;
    });
}

export function topBy<T extends string>(
  albums: Album[],
  key: (a: Album) => T,
  limit: number
): { label: T; plays: number }[] {
  const tally = new Map<T, number>();
  for (const a of albums) tally.set(key(a), (tally.get(key(a)) ?? 0) + a.play_count);
  return [...tally.entries()]
    .map(([label, plays]) => ({ label, plays }))
    .sort((x, y) => y.plays - x.plays)
    .slice(0, limit);
}
