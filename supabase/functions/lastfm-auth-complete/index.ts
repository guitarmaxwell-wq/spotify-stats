/**
 * lastfm-auth-complete (docs/REWARDS.md section 9).
 *
 * Last.fm's browser redirect: GET ?state=<nonce>&token=<token>. No user JWT, so
 * this function MUST be deployed with --no-verify-jwt. The nonce is what ties
 * the approval to a Milk user; the token alone proves nothing about which Milk
 * user is on the other end.
 *
 * Always answers 302 -> milk://auth/lastfm?status=ok
 *                    or milk://auth/lastfm?status=error&reason=<code>
 */

import { getSession, LastfmError } from "../_shared/lastfm/api.ts";
import { env, serviceClient } from "../_shared/lastfm/http.ts";
import { parseCallback } from "../_shared/lastfm/callback.ts";

const APP_RETURN = "milk://auth/lastfm";

type Reason = "bad_state" | "expired_state" | "already_linked" | "lastfm_rejected" | "server_error";

function redirect(reason?: Reason): Response {
  const q = reason ? `status=error&reason=${reason}` : "status=ok";
  return new Response(null, {
    status: 302,
    headers: { location: `${APP_RETURN}?${q}`, "cache-control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const { state, token } = parseCallback(new URL(req.url));
  if (!state) return redirect("bad_state");

  let db;
  try {
    db = serviceClient();
  } catch (e) {
    console.error("lastfm-auth-complete: config", e);
    return redirect("server_error");
  }

  // 1. Consume the nonce FIRST, atomically. Single-use even if what follows fails.
  const { data: consumed, error: e1 } = await db.rpc("lastfm_consume_state", { p_nonce: state });
  if (e1) {
    console.error("lastfm-auth-complete: consume", e1.message);
    return redirect("server_error");
  }
  const c = (Array.isArray(consumed) ? consumed[0] : consumed) as { user_id: string | null; status: string };
  if (c?.status === "expired_state") return redirect("expired_state");
  if (c?.status !== "ok" || !c.user_id) return redirect("bad_state");

  // 2. The user declined, or Last.fm sent no token.
  if (!token) return redirect("lastfm_rejected");

  // 3. Exchange the token. The session's `name` is the account that approved it.
  let session: { name: string; key: string };
  try {
    session = await getSession(token, env("LASTFM_API_KEY"), env("LASTFM_SHARED_SECRET"));
  } catch (e) {
    if (e instanceof LastfmError && e.code) {
      console.warn("lastfm-auth-complete: Last.fm refused", e.code, e.message);
      return redirect("lastfm_rejected");
    }
    console.error("lastfm-auth-complete: getSession", e);
    return redirect("server_error");
  }

  // 4. Link. Refuses an account another user owns; never moves one.
  const { data: linked, error: e2 } = await db.rpc("lastfm_link_account", {
    p_user: c.user_id,
    p_name: session.name,
    p_session_key: session.key,
  });
  if (e2) {
    console.error("lastfm-auth-complete: link", e2.message);
    return redirect("server_error");
  }
  if (linked === "already_linked") return redirect("already_linked");
  if (linked !== "ok") return redirect("server_error");
  return redirect();
});
