import { useState } from 'react';
import { Centered } from '../App';
import type { Backend } from '../backend/types';

export function SignIn({ backend, notice }: { backend: Backend; notice?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Centered>
      <h1>
        <span className="logo">Milk</span> admin
      </h1>
      <p className="dim">Reward rules and the rewards catalog. Admins only.</p>
      {notice && <p className="error">{notice}</p>}
      {backend.mode === 'demo' && <p className="banner demo inline">DEMO MODE: any email signs in; nothing is sent.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => backend.signInWithPassword(email.trim(), password));
        }}
      >
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        {sent && <p className="ok">{sent}</p>}
        <div className="row">
          <button type="submit" disabled={busy || !email || !password}>
            Sign in
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy || !email}
            onClick={() =>
              run(async () => {
                await backend.sendMagicLink(email.trim());
                setSent(`Sign-in link sent to ${email.trim()}. Open it in this browser.`);
              })
            }
          >
            Email me a sign-in link
          </button>
        </div>
        <p className="fine">
          No password yet? Use the email link. After signing in, an account that is not an admin sees its user id, which the owner adds to the{' '}
          <code>admins</code> table.
        </p>
      </form>
    </Centered>
  );
}
