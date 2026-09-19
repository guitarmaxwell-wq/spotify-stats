// POST { rule_id?: uuid, user_id?: uuid } -> { evaluated_users, granted, skipped_rules }
//
// Callers: an admin (after saving a rule, so a loosened rule grants
// retroactively) or server code holding the service-role key. Server code in
// this project should prefer calling evaluateUser() from
// _shared/rules/evaluate.ts directly, not this endpoint.

import { evaluate, RuleNotFoundError } from "../_shared/rules/evaluate.ts";
import { authorize, CORS, errorResponse, json, readJson, serviceClient, UUID } from "../_shared/rules/http.ts";
import { RuleValidationError } from "../_shared/rules/validate.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return errorResponse(405, "Use POST.");

  const db = serviceClient();
  const caller = await authorize(req, db, true);
  if (caller instanceof Response) return caller;

  const body = await readJson(req);
  if (body instanceof Response) return body;
  const { rule_id, user_id } = body;
  for (const [name, v] of [["rule_id", rule_id], ["user_id", user_id]] as const) {
    if (v !== undefined && v !== null && (typeof v !== "string" || !UUID.test(v))) {
      return errorResponse(400, `${name} must be a uuid.`);
    }
  }

  try {
    const result = await evaluate(db, {
      ruleId: (rule_id as string | null) ?? undefined,
      userId: (user_id as string | null) ?? undefined,
    });
    return json(result);
  } catch (e) {
    if (e instanceof RuleValidationError) return errorResponse(400, e.message);
    if (e instanceof RuleNotFoundError) return errorResponse(404, e.message);
    console.error("rules-evaluate failed:", e);
    return errorResponse(500, "Evaluation failed.");
  }
});
