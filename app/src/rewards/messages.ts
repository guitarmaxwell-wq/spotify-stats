/**
 * The `reason` codes from docs/REWARDS.md section 9, said the way a person
 * would say them. Every code gets a sentence that tells the user what happened
 * AND what to do next; a bare "error" leaves them stuck.
 */

import type { LastfmReason } from './types';

const REASONS: Record<LastfmReason, string> = {
  bad_state:
    "That approval didn't match a link request from this app, so we ignored it. Tap Connect Last.fm to start again.",
  expired_state:
    'That approval took longer than 10 minutes and the link request expired. Tap Connect Last.fm to try again. It only takes a moment.',
  already_linked:
    'That Last.fm account is already linked to a different Milk account. Each Last.fm account can belong to only one person. If it is yours, sign in with the email you used before.',
  lastfm_rejected:
    "Last.fm didn't confirm the approval. You may have tapped No, or Last.fm had a hiccup. Try again, and tap Yes, allow access on the Last.fm page.",
  server_error:
    "Something went wrong on Milk's side while finishing the link. Nothing was changed. Please try again in a minute.",
};

export function reasonText(reason: string): string {
  return (
    (REASONS as Record<string, string>)[reason] ??
    `Linking didn't finish (${reason}). Please try again.`
  );
}

/** Pulls `status` and `reason` out of `milk://auth/lastfm?status=...`. */
export function parseLastfmReturn(url: string): { status: string | null; reason: string | null } {
  const query = url.split('?')[1]?.split('#')[0] ?? '';
  const params: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    try {
      params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      /* malformed escape: ignore that pair */
    }
  }
  return { status: params.status ?? null, reason: params.reason ?? null };
}
