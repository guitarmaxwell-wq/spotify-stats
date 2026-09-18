/**
 * TypeScript mirror of the `data/collection.json` contract in docs/SPEC.md.
 *
 * Assumptions where the spec is ambiguous (see app/README.md for the full list):
 *  - `unlocked_at` is `string | null`; the spec only shows the unlocked case, and
 *    an in-progress album has no completing play, so null is the only sane value.
 *  - `cover_url` is `string | null` and is assumed to be missing most of the time.
 *  - `missing_tracks` is a list of plain track-title strings (the spec shows an
 *    empty array only). Titles may carry " - Remastered"-style suffixes.
 *  - `unresolved[].reason` is a free-form string; the app never branches on it.
 *  - `completion` is 0..1 and is treated as authoritative for sorting, but the
 *    UI recomputes played/total for the "12 of 14" style labels.
 */

export interface CollectionStats {
  total_plays: number;
  distinct_artists: number;
  first_play: string;
  last_play: string;
  unlocked_count: number;
  in_progress_count: number;
}

export interface Genre {
  id: string;
  label: string;
  album_count: number;
}

export interface Album {
  id: string;
  artist: string;
  title: string;
  release_year: number | null;
  genre_id: string;
  cover_url: string | null;
  total_tracks: number;
  played_tracks: number;
  completion: number;
  unlocked: boolean;
  unlocked_at: string | null;
  play_count: number;
  missing_tracks: string[];
  source: string;
  /**
   * The two dominant colors of the album artwork, as hex, contrast-checked
   * against the dark UI. Added by the pipeline and OPTIONAL here because it is
   * not in `collection.json` yet: the "Almost there" progress bar derives an
   * equivalent pair from `id` whenever this is missing (see
   * `components/ProgressGradientBar.tsx`).
   */
  colors?: { primary: string; secondary: string };
}

export interface UnresolvedAlbum {
  artist: string;
  album: string;
  reason: string;
  play_count: number;
}

export interface Collection {
  generated_at: string;
  stats: CollectionStats;
  genres: Genre[];
  albums: Album[];
  unresolved: UnresolvedAlbum[];
}

/** A genre plus its albums, front-to-back in crate order. */
export interface Crate {
  genre: Genre;
  albums: Album[];
  unlockedCount: number;
}
