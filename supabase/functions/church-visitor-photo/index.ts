import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cors, json, secretKey } from "../_shared/server.ts";

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  try {
    const token = req.headers.get("Authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return json({ error: "Authentication required" }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth.user) return json({ error: "Authentication required" }, 401);
    const body = await req.json();
    if (Object.keys(body).some(k => !["churchId", "visitorId"].includes(k)) ||
        ![body.churchId, body.visitorId].every(value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) return json({ error: "Invalid request" }, 400);
    const { data: member, error: memberError } = await admin.from("church_users").select("role,invitation_status")
      .eq("church_id", body.churchId).eq("user_id", auth.user.id).maybeSingle();
    const { data: allowed, error: accessError } = await admin.rpc("trial_access_allowed", { target_church_id: body.churchId });
    if (memberError || member?.invitation_status !== "active" || !["admin", "outreach", "greeter"].includes(member?.role) || accessError || allowed !== true) return json({ error: "Church access required" }, 403);
    const { data: visitor, error: visitorError } = await admin.from("visitors").select("photo_url")
      .eq("church_id", body.churchId).eq("id", body.visitorId).maybeSingle();
    if (visitorError || !visitor?.photo_url || !visitor.photo_url.startsWith(body.churchId + "/") || visitor.photo_url.includes("..")) return json({ error: "Photo unavailable" }, 404);
    const { data: photo, error } = await admin.storage.from("visitor-photos").download(visitor.photo_url);
    if (error || !photo) return json({ error: "Photo unavailable" }, 404);
    // No reusable signed Storage token. Each subsequent API fetch checks access.
    return new Response(photo, { headers: { ...cors, "Content-Type": "application/octet-stream", "Cache-Control": "private, no-store" } });
  } catch (_) { return json({ error: "Photo unavailable" }, 503); }
});
