import { useMemo, useState } from 'react';
import { KeepNotice, Modal, RewardLabel } from '../components';
import { useApp } from '../ctx';
import { describeTarget, useRulesData } from '../data';
import { DryRunSummary } from '../DryRun';
import { ago, n, plural, shortDate } from '../format';
import { dryRunPayload, isWildcard, RULE_TYPES, ruleTypeDef } from '../ruleTypes';
import { SkippedRules } from './RuleEditor';
import type { DryRunResult, EvaluateResult, Rule } from '../types';

type Pending =
  | { rule: Rule; to: false }
  | { rule: Rule; to: true; dry?: DryRunResult; dryError?: string }
  | null;

export function RulesList() {
  const { backend, fns, session, navigate } = useApp();
  const { rules, setRules, rewards, names, loading, error } = useRulesData(backend);
  const [type, setType] = useState('');
  const [artistQ, setArtistQ] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ text: string; kind: 'ok' | 'error'; skipped?: EvaluateResult['skipped_rules'] } | null>(null);
  const [evalAll, setEvalAll] = useState(false);

  const rewardById = useMemo(() => new Map(rewards.map((r) => [r.id, r])), [rewards]);

  const shown = rules.filter((r) => {
    if (type && r.type !== type) return false;
    if (status === 'active' && !r.active) return false;
    if (status === 'inactive' && r.active) return false;
    if (artistQ.trim()) {
      const q = artistQ.trim().toLowerCase();
      const t = describeTarget(r.type, r.params, names);
      const hay = `${t.text} ${r.params.artist ?? ''} ${r.params.album ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const askToggle = async (rule: Rule) => {
    setFlash(null);
    if (rule.active) return setPending({ rule, to: false });
    // Activating grants retroactively, so it gets a dry run too.
    setPending({ rule, to: true });
    try {
      const dry = await fns.dryRun(dryRunPayload(rule));
      setPending((p) => (p && p.rule.id === rule.id ? { rule, to: true, dry } : p));
    } catch (e) {
      setPending((p) => (p && p.rule.id === rule.id ? { rule, to: true, dryError: (e as Error).message } : p));
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const updated = await backend.updateRule(pending.rule.id, { active: pending.to }, session.userId);
      setRules((rs) => rs.map((r) => (r.id === updated.id ? updated : r)));
      if (pending.to) {
        let ev: EvaluateResult | null = null;
        try {
          ev = await fns.evaluate({ rule_id: updated.id });
        } catch (e) {
          setFlash({ kind: 'error', text: `Activated, but rules-evaluate failed: ${(e as Error).message}` });
        }
        if (ev) setFlash({ kind: 'ok', text: `Activated.${fns.mode === 'mock' ? ' [MOCK]' : ''} ${n(ev.granted)} new grants across ${plural(ev.evaluated_users, 'user')}.`, skipped: ev.skipped_rules });
      } else {
        setFlash({ kind: 'ok', text: 'Deactivated. No new grants from this rule; existing grants are kept.' });
      }
      setPending(null);
    } catch (e) {
      setFlash({ kind: 'error', text: (e as Error).message });
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="toolbar">
        <h1>Rules</h1>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type">
          <option value="">All types</option>
          {RULE_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
        <input placeholder="Filter by artist or album" value={artistQ} onChange={(e) => setArtistQ(e.target.value)} aria-label="Filter by artist" />
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter by status">
          <option value="all">Active and inactive</option>
          <option value="active">Active only</option>
          <option value="inactive">Inactive only</option>
        </select>
        <div className="spacer" />
        <button
          className="ghost"
          disabled={evalAll}
          title="Run every active rule for every user. Grants only; nothing is ever revoked."
          onClick={async () => {
            setEvalAll(true);
            setFlash(null);
            try {
              const ev = await fns.evaluate({});
              setFlash({
                kind: 'ok',
                text:
                  `Evaluated every active rule.${fns.mode === 'mock' ? ' [MOCK]' : ''} ${n(ev.granted)} new grants across ${plural(ev.evaluated_users, 'user')}.`,
                skipped: ev.skipped_rules,
              });
            } catch (e) {
              setFlash({ kind: 'error', text: (e as Error).message });
            } finally {
              setEvalAll(false);
            }
          }}
        >
          {evalAll ? 'Evaluating…' : 'Evaluate all'}
        </button>
        <button className="primary" onClick={() => navigate('#/rules/new')}>
          New rule
        </button>
      </div>
      {flash && (
        <div>
          <p className={flash.kind === 'ok' ? 'ok flash' : 'error flash'}>{flash.text}</p>
          <SkippedRules skipped={flash.skipped} />
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="dim">Loading…</p>
      ) : (
        <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Active</th>
              <th>Type</th>
              <th>Target</th>
              <th className="num">Threshold</th>
              <th>Reward</th>
              <th>Window</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const t = describeTarget(r.type, r.params, names);
              const def = ruleTypeDef(r.type);
              return (
                <tr key={r.id} className={r.active ? '' : 'off'} onClick={() => navigate(`#/rules/${r.id}`)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button
                      className={`toggle ${r.active ? 'on' : ''}`}
                      role="switch"
                      aria-checked={r.active}
                      aria-label={`${r.active ? 'Deactivate' : 'Activate'} rule`}
                      onClick={() => askToggle(r)}
                    >
                      <span />
                    </button>
                  </td>
                  <td>
                    {def.label}
                    {def.milestone === '1b' && <span className="tag">1b</span>}
                  </td>
                  <td>
                    <span className={t.wildcard ? 'wild' : t.unknown ? 'dim mono' : ''}>{t.wildcard ? `* ${t.text}` : t.text}</span>
                    {r.notes && <div className="fine clip">{r.notes}</div>}
                  </td>
                  <td className="num">{def.hasThreshold ? n(r.params.threshold ?? 0) : '—'}</td>
                  <td>
                    <RewardLabel reward={rewardById.get(r.reward_id)} />
                  </td>
                  <td className="small">
                    {r.starts_at || r.ends_at ? (
                      <>
                        {r.starts_at ? shortDate(r.starts_at) : '…'} → {r.ends_at ? shortDate(r.ends_at) : '…'}
                      </>
                    ) : (
                      <span className="dim">always</span>
                    )}
                  </td>
                  <td className="small" title={`${r.updated_at} by ${r.updated_by ?? 'unknown'}`}>
                    {ago(r.updated_at)}
                    <div className="dim">{r.updated_by === session.userId ? 'you' : r.updated_by?.slice(0, 8) ?? ''}</div>
                  </td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={7} className="empty-row">
                  {rules.length ? 'No rules match these filters.' : 'No rules yet. Create rewards first, then a rule that grants one.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      )}

      {pending && (
        <Modal title={pending.to ? 'Activate rule?' : 'Deactivate rule?'} onClose={() => !busy && setPending(null)}>
          <p>
            <b>{ruleTypeDef(pending.rule.type).label}</b> · {describeTarget(pending.rule.type, pending.rule.params, names).text}
            {ruleTypeDef(pending.rule.type).hasThreshold && <> · {n(pending.rule.params.threshold ?? 0)}</>} →{' '}
            {rewardById.get(pending.rule.reward_id)?.name}
          </p>
          {pending.to === false ? (
            <KeepNotice>Deactivating stops new grants from this rule. Nobody loses a reward they already earned.</KeepNotice>
          ) : pending.dry ? (
            <>
              <p className="fine">Activating grants retroactively to everyone who qualifies now:</p>
              <DryRunSummary result={pending.dry} subject={ruleTypeDef(pending.rule.type).subject} wildcard={isWildcard(pending.rule.type, pending.rule.params)} mock={fns.mode === 'mock'} />
            </>
          ) : pending.dryError ? (
            <p className="error">Dry run failed: {pending.dryError}</p>
          ) : (
            <p className="dim">Running dry run…</p>
          )}
          <div className="row end">
            <button className="ghost" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </button>
            <button className="primary" onClick={confirm} disabled={busy || (pending.to && !pending.dry)}>
              {busy ? 'Working…' : pending.to ? 'Activate' : 'Deactivate'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
