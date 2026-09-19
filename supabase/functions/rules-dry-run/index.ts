// POST { rule: { type, params, reward_id } } -> see docs/REWARDS.md section 9.
//
// Admins only. NEVER writes: it only reads aggregates and existing grants.
// A malformed rule returns 400 { error } with a message meant for a human.

import { dryRun } from "../_shared/rules/dry_run.ts";
import { authorize, CORS, errorResponse, json, readJson, serviceClient } from "../_shared/rules/http.ts";
import { RuleValidationError } from "../_shared/rules/validate.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return errorResponse(405, "Use POST.");

  const db = serviceClient();
  const caller = await authorize(req, db, false);
  if (caller instanceof Response) return caller;

  const body = await readJson(req);
  if (body instanceof Response) return body;
  const rule = body.rule;
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
    return errorResponse(400, 'Body must be { "rule": { "type", "params", "reward_id" } }.');
  }
  const r = rule as Record<string, unknown>;

  try {
    return json(await dryRun(db, { type: r.type, params: r.params, reward_id: r.reward_id }));
  } catch (e) {
    if (e instanceof RuleValidationError) return errorResponse(400, e.message);
    console.error("rules-dry-run failed:", e);
    return errorResponse(500, "Dry run failed.");
  }
});
