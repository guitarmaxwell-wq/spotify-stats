import { useState } from 'react';
import { Centered } from '../App';
import type { Backend } from '../backend/types';
import type { Session } from '../types';

export function NotAdmin({ backend, session, error }: { backend: Backend; session: Session; error?: string }) {
  const [copied, setCopied] = useState(false);
  const sql = `insert into public.admins (user_id) values ('${session.userId}');`;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* select manually */
    }
  };
  return (
    <Centered>
      <h1>{error ? 'Could not check admin rights' : 'Not an admin'}</h1>
      {error ? (
        <p className="error">{error}</p>
      ) : (
        <p>
          You are signed in as <b>{session.email ?? 'an account with no email'}</b>, but this account is not in <code>admins</code>, so the
          dashboard stays closed. Nothing here can change that from the browser: it takes a row added on the server.
        </p>
      )}
      <label>
        Your user id
        <div className="copyrow">
          <code className="uid" data-testid="user-id">
            {session.userId}
          </code>
          <button className="small" onClick={() => copy(session.userId)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </label>
      <p className="fine">To make this account an admin, run this in the Supabase SQL editor (or send the id to whoever can):</p>
      <pre className="sql">{sql}</pre>
      <div className="row">
        <button onClick={() => window.location.reload()}>Check again</button>
        <button className="ghost" onClick={() => backend.signOut()}>
          Sign out
        </button>
      </div>
    </Centered>
  );
}
