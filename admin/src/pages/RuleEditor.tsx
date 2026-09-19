import { useEffect, useMemo, useState } from 'react';
import { KeepNotice, RewardLabel } from '../components';
import { useApp } from '../ctx';
import { describeTarget, resolveNames } from '../data';
import { DryRunSummary } from '../DryRun';
import { ago, fromLocalInput, n, plural, shortDate, toLocalInput } from '../format';
import {
  cleanParams,
  dryRunPayload,
  isWildcard,
  payloadKey,
  rewardIncompatibility,
  RULE_TYPES,
  ruleTypeDef,
  targetOf,
  validateDraft,
  WILDCARD,
  type Issue,
} from '../ruleTypes';
import { TargetPicker, type Picked } from '../TargetPicker';
import type { DryRunResult, EvaluateResult, Reward, Rule, RuleDraft, RuleType } from '../types';

const EMPTY: RuleDraft = {
  type: 'artist_plays',
  params: {},
  reward_id: '',
  active: true,
  starts_at: null,
  ends_at: null,
  notes: null,
};

function draftOf(r: Rule): RuleDraft {
  return {
    type: r.type,
    params: { ...r.params },
    reward_id: r.reward_id,
    active: r.active,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    notes: r.notes,
  };
}

type SaveOutcome = { rule: Rule; created: boolean; evaluate: EvaluateResult | 'inactive' | { error: string } };

// A new rule's page re-mounts under its real id; carry the save result across.
let carried: SaveOutcome | null = null;

export function RuleEditor({ id }: { id?: string }) {
  const { backend, fns, session, navigate } = useApp();
  const [saved, setSaved] = useState<Rule | undefined>();
  const [draft, setDraft] = useState<RuleDraft>(EMPTY);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showErrors, setShowErrors] = useState(false);
  const [dry, setDry] = useState<{ key: string; result: DryRunResult; mock: boolean } | null>(null);
  const [dryBusy, setDryBusy] = useState(false);
  const [dryError, setDryError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [outcome, setOutcome] = useState<SaveOutcome | null>(() => (carried && carried.rule.id === id ? carried : null));
  useEffect(() => {
    if (carried?.rule.id === id) carried = null;
  }, [id]);
  const [evalBusy, setEvalBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [rw, rules] = await Promise.all([backend.listRewards(), id ? backend.listRules() : Promise.resolve([])]);
        setRewards(rw);
        if (id) {
          const r = rules.find((x) => x.id === id);
          if (!r) throw new Error('No rule with that id.');
          setSaved(r);
          setDraft(draftOf(r));
          const names = await resolveNames(backend, [r]);
          const def = ruleTypeDef(r.type);
          const key = def.target === 'artist' ? r.params.artist : r.params.album;
          if (key) {
            const t = describeTarget(r.type, r.params, names);
            let artistId: string | null = null;
            if (def.target === 'artist' && key !== WILDCARD) artistId = (await backend.artistsByMbid([key]))[0]?.id ?? null;
            setPicked({ key, label: t.text, artistId, note: t.unknown ? 'Not found in the catalog.' : undefined });
          }
        }
      } catch (e) {
        setLoadError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [backend, id]);

  const def = ruleTypeDef(draft.type);
  const issues = useMemo(() => validateDraft(draft, rewards, picked?.artistId), [draft, rewards, picked]);
  const errors = issues.filter((i) => i.level === 'error');
  const key = payloadKey(draft);
  const dryCurrent = dry?.key === key && dry.mock === (fns.mode === 'mock');
  const payloadUnchanged = saved ? payloadKey(draftOf(saved)) === key : false;
  const reward = rewards.find((r) => r.id === draft.reward_id);
  const wildcard = isWildcard(draft.type, draft.params);
  // The rules_validate trigger rejects a mismatched reward, so only offer the ones
  // this rule can actually grant (plus whatever is already selected, so an
  // existing mismatch is visible rather than silently swapped).
  const target = targetOf(draft.type, draft.params);
  const compatible = rewards.filter((r) => rewardIncompatibility(draft.type, target, r) === null);
  const hidden = rewards.length - compatible.length;
  const pickable = reward && !compatible.includes(reward) ? [...compatible, reward] : compatible;

  const set = (patch: Partial<RuleDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setOutcome(null);
  };
  const setParams = (patch: Partial<RuleDraft['params']>) => set({ params: { ...draft.params, ...patch } });

  const changeType = (type: RuleType) => {
    const next = ruleTypeDef(type);
    // Keep the target only if the new type takes the same kind of target.
    const keep = next.target !== null && next.target === def.target;
    set({ type, params: cleanParams(type, keep ? draft.params : { threshold: draft.params.threshold }) });
    if (!keep) setPicked(null);
  };

  const runDry = async () => {
    setShowErrors(true);
    setDryError('');
    if (errors.length) return;
    setDryBusy(true);
    try {
      const result = await fns.dryRun(dryRunPayload(draft));
      setDry({ key, result, mock: fns.mode === 'mock' });
    } catch (e) {
      setDryError((e as Error).message);
    } finally {
      setDryBusy(false);
    }
  };

  const evaluate = async (rule: Rule): Promise<SaveOutcome['evaluate']> => {
    if (!rule.active) return 'inactive';
    try {
      return await fns.evaluate({ rule_id: rule.id });
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

  const save = async () => {
    setShowErrors(true);
    if (errors.length || (!dryCurrent && !payloadUnchanged)) return;
    setSaving(true);
    setSaveError('');
    try {
      const body: RuleDraft = { ...draft, params: cleanParams(draft.type, draft.params), notes: draft.notes?.trim() || null };
      const rule = saved ? await backend.updateRule(saved.id, body, session.userId) : await backend.createRule(body, session.userId);
      // Saving a rule evaluates it for everyone, so a loosened rule applies retroactively.
      const ev = await evaluate(rule);
      const result = { rule, created: !saved, evaluate: ev };
      if (!saved) {
        carried = result;
        window.location.replace(`#/rules/${rule.id}`);
        return;
      }
      setOutcome(result);
      setSaved(rule);
      setDraft(draftOf(rule));
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const evaluateNow = async () => {
    if (!saved) return;
    setEvalBusy(true);
    setOutcome({ rule: saved, created: false, evaluate: await evaluate(saved) });
    setEvalBusy(false);
  };

  if (loading) return <p className="dim">Loading…</p>;
  if (loadError) return <p className="error">{loadError}</p>;

  const err = (field: Issue['field']) => (showErrors ? issues.filter((i) => i.field === field && i.level === 'error') : []);
  const warn = (field: Issue['field']) => issues.filter((i) => i.field === field && i.level === 'warning');
  const fieldMsgs = (field: Issue['field']) => (
    <>
      {err(field).map((i) => (
        <p key={i.message} className="field-error" role="alert">
          {i.message}
        </p>
      ))}
      {warn(field).map((i) => (
        <p key={i.message} className="fine warn">
          {i.message}
        </p>
      ))}
    </>
  );

  // Never-revoke (section 4): say so wherever an edit would otherwise look like a take-back.
  const was = saved ? draftOf(saved) : null;
  const oldT = was?.params.threshold;
  const newT = draft.params.threshold;
  const raised = was && def.hasThreshold && was.type === draft.type && oldT !== undefined && newT !== undefined && newT > oldT;
  const lowered = was && def.hasThreshold && was.type === draft.type && oldT !== undefined && newT !== undefined && newT < oldT;
  const deactivating = was?.active && !draft.active;
  const rewardChanged = was && was.reward_id !== draft.reward_id && draft.reward_id;
  const targetChanged = was && (was.type !== draft.type || JSON.stringify(cleanParams(was.type, was.params)) !== JSON.stringify(cleanParams(draft.type, draft.params))) && !raised && !lowered;
  const windowEnds = draft.ends_at && draft.ends_at !== was?.ends_at;

  const canSave = !errors.length && (dryCurrent || payloadUnchanged) && !saving;

  return (
    <div className="editor">
      <div className="crumbs">
        <a href="#/rules">Rules</a> / {saved ? 'Edit rule' : 'New rule'}
        {saved && (
          <span className="dim small">
            {' '}
            · updated {ago(saved.updated_at)} by {saved.updated_by === session.userId ? 'you' : saved.updated_by?.slice(0, 8) ?? 'unknown'}
          </span>
        )}
      </div>

      <div className="editor-grid">
        <form className="card" onSubmit={(e) => e.preventDefault()}>
          <label>
            Type
            <select value={draft.type} onChange={(e) => changeType(e.target.value as RuleType)} aria-label="Rule type">
              {RULE_TYPES.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                  {t.milestone === '1b' ? ' (needs album catalog, 1b)' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="fine">{def.explain}</p>
          {def.milestone === '1b' && <p className="fine warn">Album rules need tracklists on the server (milestone 1b). Until then they grant nothing.</p>}

          {def.target && (
            <div className="field">
              <span className="field-label">{def.target === 'artist' ? 'Artist' : 'Album'}</span>
              <TargetPicker
                key={def.target}
                kind={def.target}
                value={picked}
                invalid={err('target').length > 0}
                onChange={(p) => {
                  setPicked(p);
                  setParams(def.target === 'artist' ? { artist: p.key } : { album: p.key });
                }}
              />
              {fieldMsgs('target')}
            </div>
          )}

          {def.hasThreshold && (
            <label>
              {def.thresholdLabel} threshold
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                className={err('threshold').length ? 'invalid' : ''}
                value={draft.params.threshold ?? ''}
                onChange={(e) => setParams({ threshold: e.target.value === '' ? undefined : Number(e.target.value) })}
                aria-label="Threshold"
              />
              {fieldMsgs('threshold')}
            </label>
          )}

          <label>
            Reward
            <select
              value={draft.reward_id}
              className={err('reward').length ? 'invalid' : ''}
              onChange={(e) => set({ reward_id: e.target.value })}
              aria-label="Reward"
            >
              <option value="">Pick a reward…</option>
              {(['sticker', 'poster', 'community'] as const).map((k) => (
                <optgroup key={k} label={k}>
                  {pickable
                    .filter((r) => r.kind === k)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                        {r.subject_kind && !r.artist_id && !r.album_id ? ` (template, per ${r.subject_kind})` : ''}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            {reward && (
              <div className="reward-preview">
                <RewardLabel reward={reward} />
              </div>
            )}
            {fieldMsgs('reward')}
            <span className="fine">
              {wildcard
                ? `Only per-${def.subject} template rewards are listed: a wildcard grants one per ${def.subject}.`
                : def.subject === null
                  ? 'Only rewards with no subject kind are listed: this type has no artist or album to resolve a template against.'
                  : `Only rewards this rule can grant are listed.`}
              {hidden > 0 && ` ${hidden} hidden.`} <a href="#/rewards">Manage rewards</a>
            </span>
          </label>

          <fieldset>
            <legend>Date window (optional)</legend>
            <div className="row">
              <label>
                Starts
                <input type="datetime-local" value={toLocalInput(draft.starts_at)} onChange={(e) => set({ starts_at: fromLocalInput(e.target.value) })} />
              </label>
              <label>
                Ends
                <input type="datetime-local" value={toLocalInput(draft.ends_at)} onChange={(e) => set({ ends_at: fromLocalInput(e.target.value) })} />
              </label>
            </div>
            <p className="fine">
              The window is about when evaluation runs, not when the plays happened: the rule grants only while it is active and now is inside the
              window. Leave both empty for always.
            </p>
            {fieldMsgs('window')}
          </fieldset>

          <label>
            Notes
            <textarea rows={2} value={draft.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} placeholder="Why this rule exists" />
          </label>

          <label className="check">
            <input type="checkbox" checked={draft.active} onChange={(e) => set({ active: e.target.checked })} /> Active
          </label>

          {raised && (
            <KeepNotice>
              Raising the threshold from {n(oldT!)} to {n(newT!)} only stops <i>new</i> grants below {n(newT!)}. Everyone who already earned this reward
              keeps it.
            </KeepNotice>
          )}
          {deactivating && <KeepNotice>Deactivating stops new grants. Nobody loses a reward they already earned from this rule.</KeepNotice>}
          {windowEnds && <KeepNotice>When the window ends, new grants stop. Rewards granted inside the window stay.</KeepNotice>}
          {rewardChanged && (
            <KeepNotice>People who earned the previous reward keep it. Saving grants the new one to everyone who qualifies.</KeepNotice>
          )}
          {targetChanged && !rewardChanged && (
            <KeepNotice>Changing what this rule targets does not take anything back from people who earned it under the old version.</KeepNotice>
          )}
          {lowered && draft.active && (
            <p className="info">Lowering the threshold is retroactive: saving grants this to everyone who now qualifies.</p>
          )}
        </form>

        <aside className="card dry-card">
          <h2>Dry run</h2>
          <p className="fine">
            Nothing is saved or granted by a dry run. It answers "who meets this rule", so it ignores the Active switch and the date window.{' '}
            {saved ? 'Changing the type, target, threshold or reward needs a fresh one before saving.' : 'Required before saving.'}
          </p>
          <button type="button" onClick={runDry} disabled={dryBusy}>
            {dryBusy ? 'Running…' : dryCurrent ? 'Run again' : 'Dry run'}
          </button>
          {showErrors && errors.length > 0 && (
            <div className="error-box" role="alert">
              <b>Fix before running:</b>
              <ul>
                {errors.map((i) => (
                  <li key={i.message}>{i.message}</li>
                ))}
              </ul>
            </div>
          )}
          {dryError && <p className="error">{dryError}</p>}
          {dry && (
            <div className={dryCurrent ? '' : 'stale'}>
              {!dryCurrent && <p className="fine warn">Out of date: the rule changed since this dry run.</p>}
              <DryRunSummary result={dry.result} subject={def.subject} wildcard={wildcard} mock={dry.mock} />
              {dryCurrent && !draft.active && <p className="fine warn">This rule is inactive, so saving grants nothing yet.</p>}
              {dryCurrent && draft.active && (draft.starts_at || draft.ends_at) && (
                <p className="fine warn">
                  These counts ignore the date window{draft.starts_at ? ` (from ${shortDate(draft.starts_at)})` : ''}: grants happen only while the rule
                  is active and now is inside it.
                </p>
              )}
            </div>
          )}

          <hr />
          <button type="button" className="primary" disabled={!canSave} onClick={save} data-testid="save-rule">
            {saving ? 'Saving…' : saved ? 'Save changes' : 'Save rule'}
          </button>
          {!dryCurrent && !payloadUnchanged && !errors.length && <p className="fine">Run a dry run for this exact rule to enable saving.</p>}
          {saveError && <p className="error">{saveError}</p>}
          {outcome && <Outcome outcome={outcome} mock={fns.mode === 'mock'} onBack={() => navigate('#/rules')} />}
          {saved && saved.active && !outcome && (
            <button type="button" className="ghost small" onClick={evaluateNow} disabled={evalBusy}>
              {evalBusy ? 'Evaluating…' : 'Evaluate now'}
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}

export function SkippedRules({ skipped }: { skipped?: { rule_id: string; error: string }[] }) {
  if (!skipped?.length) return null;
  return (
    <div className="error-box" role="alert">
      <b>{plural(skipped.length, 'rule')} skipped as malformed, and granted nothing:</b>
      <ul>
        {skipped.map((s) => (
          <li key={s.rule_id}>
            <a href={`#/rules/${s.rule_id}`}>{s.rule_id.slice(0, 8)}</a>: {s.error}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Outcome({ outcome, mock, onBack }: { outcome: SaveOutcome; mock: boolean; onBack: () => void }) {
  const ev = outcome.evaluate;
  return (
    <div className="outcome" role="status" data-testid="save-outcome">
      <p className="ok">{outcome.created ? 'Rule created.' : 'Rule saved.'}</p>
      {ev === 'inactive' ? (
        <p className="fine">Inactive, so it was not evaluated. Activate it to start granting.</p>
      ) : 'error' in ev ? (
        <p className="error">
          Saved, but <code>rules-evaluate</code> failed: {ev.error} Existing users only receive it at their next sync until it runs; use "Evaluate now".
        </p>
      ) : (
        <>
          <p>
            {mock && <span className="mock-tag">MOCK</span>} Evaluated {plural(ev.evaluated_users, 'user')}: {n(ev.granted)} new{' '}
            {ev.granted === 1 ? 'grant' : 'grants'}.
          </p>
          <SkippedRules skipped={ev.skipped_rules} />
        </>
      )}
      <button type="button" className="ghost small" onClick={onBack}>
        Back to rules
      </button>
    </div>
  );
}
