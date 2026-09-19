import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createDemoBackend, type DemoStart } from './backend/mock';
import { liveBackend } from './backend/supabase';
import './styles.css';

// `?demo` (or ?demo=notadmin / ?demo=signedout) runs the whole dashboard against
// an in-memory backend with a fake admin. Nothing reaches Supabase.
const demoParam = new URLSearchParams(window.location.search).get('demo');
const backend =
  demoParam === null ? liveBackend : createDemoBackend((['notadmin', 'signedout'].includes(demoParam) ? demoParam : 'admin') as DemoStart);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App backend={backend} />
  </StrictMode>,
);
