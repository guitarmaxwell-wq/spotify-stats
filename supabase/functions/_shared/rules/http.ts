// HTTP plumbing for the rules Edge Functions: CORS, JSON, and the caller check.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// The admin dashboard is a browser app on another origin. Every request is
// still authorised by its bearer token below; CORS only lets the browser send it.
export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export function errorResponse(status: number, error: string): Response {
  return json({ error }, status);
}

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export type Caller = { kind: "server" } | { kind: "admin"; userId: string };

/**
 * Who is calling? Returns a Caller, or an error Response to send back.
 *
 * - `server`: the bearer token IS this project's service-role key (only other
 *   Edge Functions have it). Accepted only when `allowServer`.
 * - `admin`: the bearer token is a valid user JWT (verified by Supabase Auth,
 *   not just decoded) AND that user is in `admins`, checked with the service
 *   role. Nothing in the request body is trusted for this.
 */
export async function authorize(req: Request, db: SupabaseClient, allowServer: boolean): Promise<Caller | Response> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("Authorization") ?? "");
  if (!m) return errorResponse(401, "Missing Authorization: Bearer <token>.");
  const token = m[1].trim();

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (serviceKey && timingSafeEqual(token, serviceKey)) {
    return allowServer ? { kind: "server" } : errorResponse(403, "This function is for admins only.");
  }

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return errorResponse(401, "Invalid or expired session.");
  const { data: admin, error: adminErr } = await db.from("admins").select("user_id").eq("user_id", data.user.id)
    .maybeSingle();
  if (adminErr) return errorResponse(500, "Could not check admin status.");
  if (!admin) return errorResponse(403, "Admins only.");
  return { kind: "admin", userId: data.user.id };
}

export async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    const text = await req.text();
    body = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return errorResponse(400, "Request body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
