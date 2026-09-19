import { n, plural } from './format';
import type { DryRunResult, SubjectKind } from './types';

/** The section-9 dry-run response, said in plain language. */
export function DryRunSummary({
  result,
  subject,
  wildcard,
  mock,
}: {
  result: DryRunResult;
  subject: SubjectKind | null;
  wildcard: boolean;
  mock: boolean;
}) {
  const { qualifying_users: q, new_grants: fresh, already_granted: had, subjects, sample } = result;
  const noun = subject === 'album' ? 'album' : 'artist';
  const grants = fresh + had;

  // Section 9: qualifying_users counts USERS; new_grants / already_granted count
  // (user, subject) GRANTS. For a wildcard one user can earn it for many artists,
  // so the two numbers must never be conflated.
  let headline: string;
  if (q === 0) {
    headline = 'Nobody qualifies right now.';
  } else if (wildcard) {
    headline =
      `${plural(q, 'user')} ${q === 1 ? 'qualifies' : 'qualify'}, for ${plural(grants, 'grant')} across ${plural(subjects, noun)}. ` +
      (fresh === 0 ? 'None of them would be new.' : `${plural(fresh, 'grant')} would be new.`);
  } else {
    headline =
      `${plural(q, 'user')} ${q === 1 ? 'qualifies' : 'qualify'}. ` +
      (fresh === 0 ? 'Nobody new would receive this: they all already have it.' : `${n(fresh)} would receive this for the first time.`);
  }

  return (
    <div className={`dryrun ${mock ? 'is-mock' : ''}`} data-testid="dry-run-result">
      {mock && <span className="mock-tag">MOCK NUMBERS</span>}
      <p className="headline">{headline}</p>
      <div className="stats">
        <Stat label={q === 1 ? 'user qualifies' : 'users qualify'} value={q} />
        <Stat label="new grants" value={fresh} accent />
        <Stat label="grants already made" value={had} />
        {wildcard && <Stat label={`${noun}s with a qualifier`} value={subjects} />}
      </div>
      {q === 0 && <p className="fine">The rule still grants as people listen: every sync re-evaluates.</p>}
      {wildcard && sample.length > 0 && (
        <>
          <p className="fine">
            A wildcard grants one reward per {noun}.{' '}
            {subjects > sample.length ? `Top ${sample.length} of ${plural(subjects, noun)}:` : `By ${noun}:`}
          </p>
          <ul className="sample">
            {sample.map((s) => (
              <li key={s.subject_key} title={s.subject_key || '(no subject)'}>
                <span>{s.subject_name ?? s.subject_key ?? ''}</span>: {plural(s.users, 'user')}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? 'accent' : ''}`}>
      <b>{n(value)}</b>
      <span>{label}</span>
    </div>
  );
}
