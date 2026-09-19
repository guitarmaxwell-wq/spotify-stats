/** Small shared plumbing for the three Last.fm Edge Functions. */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

/** Service-role client. Bypasses RLS: use only after the caller is authenticated. */
export function serviceClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The signed-in caller's user id, validated by the Auth server, or null. */
export async function callerId(req: Request, db: SupabaseClient): Promise<string | null> {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const { data, error } = await db.auth.getUser(m[1]);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

export function functionUrl(name: string): string {
  return `${env("SUPABASE_URL").replace(/\/+$/, "")}/functions/v1/${name}`;
}

/** 32 random bytes, base64url: 43 characters, 256 bits of entropy. */
export function mintNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
