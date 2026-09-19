import { useEffect, useMemo, useState } from 'react';
import { createMockFunctions, seedLedger } from './backend/mock';
import { FnError, liveConfigured, liveFunctions } from './backend/supabase';
import type { Backend, RuleFunctions } from './backend/types';
import { AppCtx } from './ctx';
import { NotAdmin } from './pages/NotAdmin';
import { Rewards } from './pages/Rewards';
import { RuleEditor } from './pages/RuleEditor';
import { RulesList } from './pages/RulesList';
import { SignIn } from './pages/SignIn';
import type { Session } from './types';

type Gate = 'loading' | 'signedout' | 'checking' | 'notadmin' | 'admin' | 'error';

const FN_KEY = 'milk-admin-functions';

function initialFnMode(backend: Backend): 'live' | 'mock' {
  if (backend.mode === 'demo') return 'mock';
  try {
    const saved = localStorage.getItem(FN_KEY);
    if (saved === 'live' || saved === 'mock') return saved;
  } catch {
    /* storage unavailable */
  }
  return import.meta.env.VITE_MOCK_FUNCTIONS === '1' ? 'mock' : 'live';
}

function useHash(): string {
  const [h, setH] = useState(window.location.hash || '#/rules');
  useEffect(() => {
    const on = () => setH(window.location.hash || '#/rules');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return h;
}

export function App({ backend }: { backend: Backend }) {
  const [session, setSession] = useState<Session | null>(null);
  const [gate, setGate] = useState<Gate>('loading');
  const [gateError, setGateError] = useState('');
  const [fnMode, setFnMode] = useState<'live' | 'mock'>(() => initialFnMode(backend));
  const hash = useHash();

  const [notice, setNotice] = useState('');
  const mockFns = useMemo(() => createMockFunctions(backend), [backend]);
  const base = fnMode === 'mock' ? mockFns : liveFunctions;
  // Section 9 errors: 401 means the session is gone (back to sign-in), 403 means
  // this account is not an admin (the not-admin screen). Everything else is
  // shown verbatim by whoever made the call.
  const fns = useMemo<RuleFunctions>(() => {
    const guard =
      <A, R>(f: (a: A) => Promise<R>) =>
      async (a: A): Promise<R> => {
        try {
          return await f(a);
        } catch (e) {
          if (e instanceof FnError && e.status === 401) {
            setNotice(`Your session is no longer valid (${e.message}). Sign in again.`);
            void backend.signOut();
          } else if (e instanceof FnError && e.status === 403) {
            setGate('notadmin');
          }
          throw e;
        }
      };
    return { mode: base.mode, dryRun: guard(base.dryRun), evaluate: guard(base.evaluate) };
  }, [base, backend]);

  useEffect(() => {
    if (backend.mode === 'demo') void seedLedger(mockFns);
  }, [backend, mockFns]);

  useEffect(() => {
    let alive = true;
    let lastUser: string | null | undefined;
    const apply = async (s: Session | null) => {
      if (!alive) return;
      // Token refreshes re-fire auth events; only re-check when the user changes.
      if (lastUser !== undefined && lastUser === (s?.userId ?? null)) return;
      lastUser = s?.userId ?? null;
      setSession(s);
      if (!s) return setGate('signedout');
      setGate('checking');
      try {
        const ok = await backend.isAdmin();
        if (alive) setGate(ok ? 'admin' : 'notadmin');
      } catch (e) {
        if (alive) {
          setGateError((e as Error).message);
          setGate('error');
        }
      }
    };
    backend.getSession().then(apply, () => apply(null));
    const off = backend.onAuthChange((s) => void apply(s));
    return () => {
      alive = false;
      off();
    };
  }, [backend]);

  const setMode = (m: 'live' | 'mock') => {
    setFnMode(m);
    try {
      localStorage.setItem(FN_KEY, m);
    } catch {
      /* ignore */
    }
  };

  if (backend.mode === 'live' && !liveConfigured) {
    return (
      <Centered>
        <h1>Milk admin</h1>
        <p className="error">admin/.env is missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy admin/.env.example.</p>
      </Centered>
    );
  }
  if (gate === 'loading' || gate === 'checking') {
    return (
      <Centered>
        <p className="dim">{gate === 'loading' ? 'Loading…' : 'Checking admin rights…'}</p>
      </Centered>
    );
  }
  if (gate === 'signedout') return <SignIn backend={backend} notice={notice} />;
  if (gate === 'notadmin' || gate === 'error') {
    return <NotAdmin backend={backend} session={session!} error={gate === 'error' ? gateError : undefined} />;
  }

  const [, page, sub] = hash.split('/');
  const navigate = (h: string) => {
    window.location.hash = h;
  };

  return (
    <AppCtx.Provider value={{ backend, fns, session: session!, navigate }}>
      <header className="topbar">
        <div className="brand">
          <span className="logo">Milk</span> admin
        </div>
        <nav>
          <a href="#/rules" className={page === 'rules' ? 'on' : ''}>
            Rules
          </a>
          <a href="#/rewards" className={page === 'rewards' ? 'on' : ''}>
            Rewards
          </a>
        </nav>
        <div className="spacer" />
        <div className="seg" title="Where dry runs and evaluations go">
          <span className="seg-label">Functions</span>
          <button className={fnMode === 'live' ? 'on' : ''} disabled={backend.mode === 'demo'} onClick={() => setMode('live')}>
            Live
          </button>
          <button className={fnMode === 'mock' ? 'on mock' : ''} onClick={() => setMode('mock')}>
            Mock
          </button>
        </div>
        <span className="who" title={session!.userId}>
          {session!.email}
        </span>
        <button className="ghost small" onClick={() => backend.signOut()}>
          Sign out
        </button>
      </header>
      {backend.mode === 'demo' && (
        <div className="banner demo">
          <b>DEMO MODE.</b> In-memory data and a fake admin. Nothing is read from or written to Supabase. Remove <code>?demo</code> from the URL for
          the real dashboard.
        </div>
      )}
      {fnMode === 'mock' && (
        <div className="banner mock">
          <b>MOCK FUNCTIONS.</b> <code>rules-dry-run</code> and <code>rules-evaluate</code> are simulated: dry-run numbers are synthetic and saving
          grants nothing to anyone.
          {backend.mode === 'live' && ' Rules you save ARE written to the real database; re-run "Evaluate now" once the functions are deployed.'}
        </div>
      )}
      <main>
        {page === 'rewards' ? (
          <Rewards />
        ) : page === 'rules' && sub ? (
          <RuleEditor key={sub} id={sub === 'new' ? undefined : sub} />
        ) : (
          <RulesList />
        )}
      </main>
    </AppCtx.Provider>
  );
}

export function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="centered">
      <div className="card narrow">{children}</div>
    </div>
  );
}
