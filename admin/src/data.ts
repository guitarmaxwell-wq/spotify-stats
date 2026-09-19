import { useCallback, useEffect, useState } from 'react';
import type { Backend } from './backend/types';
import { ruleTypeDef, WILDCARD } from './ruleTypes';
import type { Reward, Rule, RuleParams, RuleType } from './types';

export interface Names {
  artists: Map<string, string>; // mbid -> name
  albums: Map<string, string>; // release mbid -> "Title · Artist"
}

export async function resolveNames(backend: Backend, rules: Pick<Rule, 'params'>[]): Promise<Names> {
  const artistKeys = [...new Set(rules.map((r) => r.params.artist).filter((k): k is string => !!k && k !== WILDCARD))];
  const albumKeys = [...new Set(rules.map((r) => r.params.album).filter((k): k is string => !!k && k !== WILDCARD))];
  const [artists, albums] = await Promise.all([backend.artistsByMbid(artistKeys), backend.albumsByMbid(albumKeys)]);
  return {
    artists: new Map(artists.map((a) => [a.mbid, a.name])),
    albums: new Map(albums.map((a) => [a.release_mbid, a.artist_name ? `${a.title} · ${a.artist_name}` : a.title])),
  };
}

export function describeTarget(type: RuleType, params: RuleParams, names: Names): { text: string; wildcard: boolean; unknown: boolean } {
  const def = ruleTypeDef(type);
  if (!def.target) return { text: 'all albums', wildcard: false, unknown: false };
  const key = def.target === 'artist' ? params.artist : params.album;
  if (!key) return { text: '(none)', wildcard: false, unknown: true };
  if (key === WILDCARD) return { text: `any ${def.target}`, wildcard: true, unknown: false };
  const name = def.target === 'artist' ? names.artists.get(key) : names.albums.get(key);
  return { text: name ?? key, wildcard: false, unknown: !name };
}

export function useRulesData(backend: Backend) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [names, setNames] = useState<Names>({ artists: new Map(), albums: new Map() });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setError('');
    try {
      const [ru, rw] = await Promise.all([backend.listRules(), backend.listRewards()]);
      setNames(await resolveNames(backend, ru));
      setRules(ru);
      setRewards(rw);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rules, setRules, rewards, names, loading, error, reload };
}
