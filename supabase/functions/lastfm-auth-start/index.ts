/**
 * lastfm-auth-start (docs/REWARDS.md section 9).
 *
 * Signed-in user, POST {} -> { url }. Mints a single-use, 10-minute nonce bound
 * to the caller and returns the Last.fm web-auth URL whose per-request `cb`
 * points at lastfm-auth-complete carrying that nonce as `state`.
 */

import { authUrl } from "../_shared/lastfm/api.ts";
import {
  callerId,
  CORS_HEADERS,
  env,
  functionUrl,
  json,
  mintNonce,
  serviceClient,
} from "../_shared/lastfm/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const db = serviceClient();
    const userId = await callerId(req, db);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const nonce = mintNonce();
    const { error } = await db.from("lastfm_auth_states").insert({ nonce, user_id: userId });
    if (error) throw new Error(`insert nonce: ${error.message}`);

    const cb = `${functionUrl("lastfm-auth-complete")}?state=${encodeURIComponent(nonce)}`;
    return json({ url: authUrl(env("LASTFM_API_KEY"), cb) });
  } catch (e) {
    console.error("lastfm-auth-start", e);
    return json({ error: "server_error" }, 500);
  }
});
