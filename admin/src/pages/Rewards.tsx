import { useEffect, useMemo, useState } from 'react';
import { Art } from '../components';
import { useApp } from '../ctx';
import { WILDCARD } from '../ruleTypes';
import { TargetPicker, type Picked } from '../TargetPicker';
import type { Reward, RewardDraft, RewardKind, SubjectKind } from '../types';

const BLANK: RewardDraft = { kind: 'sticker', name: '', description: null, art_url: null, subject_kind: null, artist_id: null, album_id: null };
const MAX_ART = 5 * 1024 * 1024;

export function Rewards() {
  const { backend } = useApp();
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [labels, setLabels] = useState<Map<string, string>>(new Map()); // artist/album id -> name
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Reward | 'new' | null>(null);
  const [kind, setKind] = useState<'' | RewardKind>('');

  const load = async () => {
    try {
      const rw = await backend.listRewards();
      const [ar, al] = await Promise.all([
        backend.artistsById([...new Set(rw.map((r) => r.artist_id).filter((x): x is string => !!x))]),
        backend.albumsById([...new Set(rw.map((r) => r.album_id).filter((x): x is string => !!x))]),
      ]);
      setLabels(new Map([...ar.map((a) => [a.id, a.name] as const), ...al.map((a) => [a.id, a.title] as const)]));
      setRewards(rw);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  const shown = rewards.filter((r) => !kind || r.kind === kind);

  return (
    <div>
      <div className="toolbar">
        <h1>Rewards</h1>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Filter by kind">
          <option value="">All kinds</option>
          <option value="sticker">Stickers</option>
          <option value="poster">Posters</option>
          <option value="community">Communities</option>
        </select>
        <div className="spacer" />
        <button className="primary" onClick={() => setEditing('new')}>
          New reward
        </button>
      </div>
      <p className="fine">
        A reward with a subject kind and no specific artist or album is a <b>template</b>: wildcard rules grant one per subject ("the Radiohead
        community"). Rewards cannot be deleted here, because deleting one would remove every grant of it, and grants are never revoked.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="rewards-layout">
        <div className="reward-grid">
          {loading && <p className="dim">Loading…</p>}
          {!loading && !shown.length && <p className="dim">No rewards yet.</p>}
          {shown.map((r) => {
            const template = r.subject_kind && !r.artist_id && !r.album_id;
            const selected = editing !== 'new' && editing?.id === r.id;
            return (
              <button key={r.id} className={`reward-card ${selected ? 'sel' : ''}`} onClick={() => setEditing(r)}>
                <Art reward={r} size={96} />
                <div className="rc-body">
                  <span className={`kind k-${r.kind}`}>{r.kind}</span>
                  <b>{r.name}</b>
                  <span className="fine">
                    {template
                      ? `template · per ${r.subject_kind}`
                      : r.artist_id || r.album_id
                        ? labels.get((r.artist_id ?? r.album_id)!) ?? 'specific subject'
                        : 'no subject'}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        {editing && (
          <RewardForm
            key={editing === 'new' ? 'new' : editing.id}
            reward={editing === 'new' ? undefined : editing}
            subjectLabel={editing !== 'new' ? labels.get((editing.artist_id ?? editing.album_id) ?? '') : undefined}
            onClose={() => setEditing(null)}
            onSaved={(r) => {
              setEditing(r);
              void load();
            }}
          />
        )}
      </div>
    </div>
  );
}

function RewardForm({
  reward,
  subjectLabel,
  onClose,
  onSaved,
}: {
  reward?: Reward;
  subjectLabel?: string;
  onClose: () => void;
  onSaved: (r: Reward) => void;
}) {
  const { backend } = useApp();
  const [d, setD] = useState<RewardDraft>(() => (reward ? { ...reward } : { ...BLANK }));
  const [file, setFile] = useState<File | null>(null);
  const [subject, setSubject] = useState<Picked | null>(() =>
    reward?.subject_kind ? { key: reward.artist_id || reward.album_id ? 'specific' : WILDCARD, label: subjectLabel ?? 'specific' } : null,
  );
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const preview = useMemo(() => (file ? URL.createObjectURL(file) : d.art_url), [file, d.art_url]);
  useEffect(() => () => void (file && preview && URL.revokeObjectURL(preview)), [file, preview]);

  const set = (p: Partial<RewardDraft>) => {
    setD((x) => ({ ...x, ...p }));
    setSaved(false);
    setErrors([]);
  };

  const setSubjectKind = (k: SubjectKind | null) => {
    set({ subject_kind: k, artist_id: null, album_id: null });
    setSubject(k ? { key: WILDCARD, label: `Any ${k}` } : null);
  };

  const pickSubject = async (p: Picked) => {
    setSubject(p);
    if (p.key === WILDCARD) return set({ artist_id: null, album_id: null });
    if (d.subject_kind === 'artist') {
      const id = p.artistId ?? (await backend.artistsByMbid([p.key]))[0]?.id ?? null;
      set({ artist_id: id, album_id: null });
      if (!id) setErrors(['That artist is not in the catalog. Pick it from the catalog or MusicBrainz results.']);
    } else {
      const al = (await backend.albumsByMbid([p.key]))[0];
      set({ album_id: al?.id ?? null, artist_id: null });
      if (!al) setErrors(['That album is not in the catalog, so a reward cannot point at it yet. Load it into albums first.']);
    }
  };

  const validate = (): string[] => {
    const e: string[] = [];
    if (!d.name.trim()) e.push('Name is required.');
    if (d.name.length > 80) e.push('Name is too long (80 max).');
    if (d.subject_kind && subject && subject.key !== WILDCARD && !d.artist_id && !d.album_id) e.push('The chosen subject is not in the catalog.');
    if (file && file.size > MAX_ART) e.push('Art must be 5 MB or smaller.');
    if (file && !file.type.startsWith('image/')) e.push('Art must be an image.');
    return e;
  };

  const save = async () => {
    const e = validate();
    setErrors(e);
    if (e.length) return;
    setBusy(true);
    try {
      const art_url = file ? await backend.uploadArt(file) : d.art_url?.trim() || null;
      const body: RewardDraft = {
        kind: d.kind,
        name: d.name.trim(),
        description: d.description?.trim() || null,
        art_url,
        subject_kind: d.subject_kind,
        artist_id: d.subject_kind === 'artist' ? d.artist_id : null,
        album_id: d.subject_kind === 'album' ? d.album_id : null,
      };
      const r = reward ? await backend.updateReward(reward.id, body) : await backend.createReward(body);
      setFile(null);
      setSaved(true);
      onSaved(r);
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card reward-form" onSubmit={(e) => (e.preventDefault(), save())}>
      <div className="row">
        <h2>{reward ? 'Edit reward' : 'New reward'}</h2>
        <div className="spacer" />
        <button type="button" className="ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="art-edit">
        <Art reward={{ art_url: preview, kind: d.kind, name: d.name }} size={128} />
        <div>
          <label>
            Art
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <p className="fine">Uploaded to the public reward-art bucket when you save.</p>
          {d.art_url && !file && (
            <button type="button" className="ghost small" onClick={() => set({ art_url: null })}>
              Remove art
            </button>
          )}
        </div>
      </div>
      <label>
        Kind
        <select value={d.kind} onChange={(e) => set({ kind: e.target.value as RewardKind })}>
          <option value="sticker">Sticker</option>
          <option value="poster">Poster</option>
          <option value="community">Community access</option>
        </select>
      </label>
      <label>
        Name
        <input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="blink-bunny" />
      </label>
      <label>
        Description
        <textarea rows={2} value={d.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
      </label>
      <label>
        Subject kind
        <select value={d.subject_kind ?? ''} onChange={(e) => setSubjectKind((e.target.value || null) as SubjectKind | null)}>
          <option value="">None (one reward, no subject)</option>
          <option value="artist">Artist</option>
          <option value="album">Album</option>
        </select>
      </label>
      {d.subject_kind && (
        <div className="field">
          <span className="field-label">{d.subject_kind === 'artist' ? 'Artist' : 'Album'}</span>
          <TargetPicker key={d.subject_kind} kind={d.subject_kind} value={subject} onChange={pickSubject} />
          <p className="fine">
            {subject?.key === WILDCARD
              ? `Template: a wildcard rule grants one of these per ${d.subject_kind}, and the app resolves art and community from that ${d.subject_kind}.`
              : `Tied to this ${d.subject_kind}.`}
          </p>
        </div>
      )}
      {d.kind === 'community' && <p className="fine">Community access is modelled in milestone 1; chat itself is not built yet.</p>}
      {errors.length > 0 && (
        <div className="error-box" role="alert">
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {saved && <p className="ok">Saved.</p>}
      <div className="row end">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : reward ? 'Save reward' : 'Create reward'}
        </button>
      </div>
    </form>
  );
}
