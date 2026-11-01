// Server-only credentials and response helpers; no billing functionality.
export const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
export function json(body: unknown, status = 200) { return Response.json(body, { status, headers: cors }); }
export function secretKey() {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY");
  if (direct) return direct;
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
  const key = keys.default || keys.secret || keys.secret_key || keys.service_role || keys.service_role_key;
  if (typeof key !== "string" || !key) throw new Error("Server configuration required");
  return key;
}
