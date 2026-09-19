/**
 * Pull state and token out of the web-auth callback query. Last.fm documents
 * appending `&token=` when the callback already has a query string (ours
 * carries `state`); if `?token=` were appended instead, the token would be
 * folded into `state`, so accept that shape too rather than fail a legitimate
 * approval. The nonce is base64url, so it can never itself contain "?token=".
 */
export function parseCallback(url: URL): { state: string | null; token: string | null } {
  let state = url.searchParams.get("state");
  let token = url.searchParams.get("token");
  if (state && !token && state.includes("?token=")) {
    const [s, t] = state.split("?token=", 2);
    state = s;
    token = t;
  }
  return { state: state || null, token: token || null };
}
