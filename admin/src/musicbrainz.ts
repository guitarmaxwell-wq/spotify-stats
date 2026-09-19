// MusicBrainz search, the fallback when the catalog has no match.
// MB allows ~1 request/second per client and serves CORS, so the pickers debounce
// and this module serialises calls.

export interface MbArtist {
  mbid: string;
  name: string;
  disambiguation?: string;
  country?: string;
}
export interface MbRelease {
  mbid: string;
  title: string;
  artist: string;
  date?: string;
  tracks?: number;
}

let last = 0;
async function mb<T>(path: string): Promise<T> {
  const wait = Math.max(0, last + 1100 - Date.now());
  last = Date.now() + wait;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  const res = await fetch(`https://musicbrainz.org/ws/2/${path}&fmt=json`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
  return res.json() as Promise<T>;
}

export async function searchMbArtists(q: string): Promise<MbArtist[]> {
  const j = await mb<{ artists: { id: string; name: string; disambiguation?: string; country?: string }[] }>(
    `artist?query=${encodeURIComponent(q)}&limit=6`,
  );
  return j.artists.map((a) => ({ mbid: a.id, name: a.name, disambiguation: a.disambiguation, country: a.country }));
}

export async function searchMbReleases(q: string): Promise<MbRelease[]> {
  const j = await mb<{
    releases: { id: string; title: string; date?: string; 'track-count'?: number; 'artist-credit'?: { name: string }[] }[];
  }>(`release?query=${encodeURIComponent(q)}&limit=6`);
  return j.releases.map((r) => ({
    mbid: r.id,
    title: r.title,
    artist: (r['artist-credit'] ?? []).map((c) => c.name).join(', '),
    date: r.date,
    tracks: r['track-count'],
  }));
}
