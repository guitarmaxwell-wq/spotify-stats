import { artistKey } from '../../app/src/link/normalize';
import { useEffect, useRef, useState } from 'react';
import { useApp } from './ctx';
import { searchMbArtists, searchMbReleases } from './musicbrainz';
import { WILDCARD } from './ruleTypes';

export interface Picked {
  key: string; // MBID, name:<key>, or '*'
  label: string;
  artistId?: string | null; // catalog artist id, when known
  note?: string; // shown under the selection, e.g. "not in catalog"
}

interface Option extends Picked {
  source: 'any' | 'catalog' | 'musicbrainz' | 'raw';
  detail?: string;
  mbName?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function TargetPicker({
  kind,
  value,
  onChange,
  invalid,
}: {
  kind: 'artist' | 'album';
  value: Picked | null;
  onChange: (p: Picked) => void;
  invalid?: boolean;
}) {
  const { backend } = useApp();
  const [open, setOpen] = useState(!value);
  const [q, setQ] = useState('');
  const [catalog, setCatalog] = useState<Option[]>([]);
  const [mb, setMb] = useState<Option[]>([]);
  const [mbState, setMbState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setMb([]);
    setMbState('idle');
    if (!q.trim()) {
      setCatalog([]);
      return;
    }
    const t1 = setTimeout(async () => {
      try {
        const opts: Option[] =
          kind === 'artist'
            ? (await backend.searchArtists(q)).map((a) => ({
                source: 'catalog',
                key: a.mbid,
                label: a.name,
                artistId: a.id,
                detail: a.mbid.startsWith('name:') ? 'no MBID (synthetic key)' : undefined,
              }))
            : (await backend.searchAlbums(q)).map((a) => ({
                source: 'catalog',
                key: a.release_mbid,
                label: a.artist_name ? `${a.title} · ${a.artist_name}` : a.title,
                detail: a.track_count ? `${a.track_count} tracks` : 'no tracklist yet',
              }));
        if (id === seq.current) setCatalog(opts);
      } catch {
        if (id === seq.current) setCatalog([]);
      }
    }, 250);
    // MusicBrainz is the fallback: slower, rate limited, so debounce harder.
    const t2 = setTimeout(async () => {
      if (q.trim().length < 2) return;
      setMbState('loading');
      try {
        const opts: Option[] =
          kind === 'artist'
            ? (await searchMbArtists(q)).map((a) => ({
                source: 'musicbrainz',
                key: a.mbid,
                label: a.name,
                mbName: a.name,
                detail: [a.disambiguation, a.country].filter(Boolean).join(' · ') || undefined,
              }))
            : (await searchMbReleases(q)).map((r) => ({
                source: 'musicbrainz',
                key: r.mbid,
                label: r.artist ? `${r.title} · ${r.artist}` : r.title,
                detail: [r.date, r.tracks ? `${r.tracks} tracks` : ''].filter(Boolean).join(' · ') || undefined,
              }));
        if (id === seq.current) {
          setMb(opts);
          setMbState('idle');
        }
      } catch {
        if (id === seq.current) setMbState('error');
      }
    }, 800);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [q, kind, backend]);

  const pick = async (o: Option) => {
    if (o.source === 'musicbrainz' && kind === 'artist') {
      // Add it to the catalog so the rule list can show a name, not an MBID.
      setBusy(true);
      try {
        const a = await backend.ensureArtist(o.key, o.mbName ?? o.label);
        onChange({ key: a.mbid, label: a.name, artistId: a.id, note: 'Added to the artist catalog from MusicBrainz.' });
      } catch (e) {
        onChange({ key: o.key, label: o.label, note: `From MusicBrainz (not added to the catalog: ${(e as Error).message}).` });
      } finally {
        setBusy(false);
      }
    } else if (o.source === 'musicbrainz' || o.source === 'raw') {
      onChange({
        key: o.key,
        label: o.label,
        note:
          kind === 'album'
            ? 'Not in the album catalog: it has no tracklist on the server, so this rule cannot grant until the album is loaded (docs/CATALOG.md).'
            : 'Not in the artist catalog. Grants still work once plays for this key are synced.',
      });
    } else {
      onChange({ key: o.key, label: o.label, artistId: o.artistId ?? null });
    }
    setOpen(false);
    setQ('');
  };

  const raw = q.trim();
  const rawIsKey = UUID.test(raw) || (kind === 'artist' && /^name:.+/.test(raw));
  // About 28% of scrobbles have no artist MBID; those artists live under
  // "name:<artistKey>" (docs/REWARDS.md section 9), using the app's normalizer so
  // the key matches what the sync writes.
  const nameKey = kind === 'artist' && raw && !rawIsKey ? `name:${artistKey(raw)}` : '';
  const catalogKeys = new Set(catalog.map((c) => c.key));
  const options: Option[] = [
    { source: 'any', key: WILDCARD, label: `Any ${kind}`, detail: `wildcard: one reward per ${kind}` },
    ...catalog,
    ...mb.filter((m) => !catalogKeys.has(m.key)),
    ...(rawIsKey && !catalogKeys.has(raw)
      ? [{ source: 'raw' as const, key: UUID.test(raw) ? raw.toLowerCase() : raw, label: raw, detail: 'use this key as typed' }]
      : []),
    ...(nameKey && nameKey !== 'name:' && !catalogKeys.has(nameKey)
      ? [{ source: 'raw' as const, key: nameKey, label: nameKey, detail: 'artist with no MusicBrainz id' }]
      : []),
  ];

  if (!open && value) {
    return (
      <div className="picked">
        <div className="picked-row">
          <span className={value.key === WILDCARD ? 'wild' : ''}>{value.key === WILDCARD ? `* Any ${kind}` : value.label}</span>
          {value.key !== WILDCARD && <code className="dim small">{value.key}</code>}
          <button type="button" className="ghost small" onClick={() => setOpen(true)}>
            Change
          </button>
        </div>
        {value.note && <p className="fine warn">{value.note}</p>}
      </div>
    );
  }

  return (
    <div className={`picker ${invalid ? 'invalid' : ''}`}>
      <input
        autoFocus={!!value}
        placeholder={kind === 'artist' ? 'Search artists, or paste an MBID / name:key' : 'Search albums, or paste a release MBID'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label={`Search ${kind}`}
      />
      <ul className="options" role="listbox">
        {options.map((o) => (
          <li key={o.source + o.key}>
            <button type="button" disabled={busy} onClick={() => pick(o)} className={o.source === 'any' ? 'wild' : ''}>
              <span className="opt-main">{o.source === 'any' ? `* ${o.label}` : o.label}</span>
              {o.detail && <span className="opt-detail">{o.detail}</span>}
              {o.source !== 'any' && <span className={`src src-${o.source}`}>{o.source === 'musicbrainz' ? 'MusicBrainz' : o.source}</span>}
            </button>
          </li>
        ))}
        {raw && mbState === 'loading' && <li className="fine">Searching MusicBrainz…</li>}
        {raw && mbState === 'error' && <li className="fine warn">MusicBrainz search failed; catalog results only.</li>}
        {raw && !catalog.length && mbState === 'idle' && !mb.length && <li className="fine">No catalog match.</li>}
      </ul>
      {value && (
        <button type="button" className="ghost small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      )}
    </div>
  );
}
