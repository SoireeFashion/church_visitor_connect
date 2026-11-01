import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function getSecretKey() {
  const direct =
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (direct) return direct;

  const packed = Deno.env.get("SUPABASE_SECRET_KEYS");

  if (packed) {
    try {
      const parsed = JSON.parse(packed);

      return (
        parsed.default ||
        parsed.SUPABASE_SECRET_KEY ||
        parsed.SUPABASE_SERVICE_ROLE_KEY ||
        parsed.service_role ||
        parsed.secret ||
        ""
      );
    } catch {
      return packed;
    }
  }

  return "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const secretKey = getSecretKey();

    if (!supabaseUrl || !anonKey || !secretKey) {
      console.error("Missing required Supabase environment variables.");
      return json({ error: "Server configuration error." }, 500);
    }

    // ---------------------------------------------------------
    // 1. Verify signed-in user
    // ---------------------------------------------------------

    const authHeader = req.headers.get("Authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Authentication required." }, 401);
    }

    const accessToken = authHeader.replace("Bearer ", "").trim();

    const authClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser(accessToken);

    if (userError || !user) {
      console.error("User verification error:", userError);
      return json({ error: "Invalid or expired session." }, 401);
    }

    // ---------------------------------------------------------
    // 2. Service client
    // ---------------------------------------------------------

    const admin = createClient(supabaseUrl, secretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    // ---------------------------------------------------------
    // 3. Confirm Platform Admin
    // ---------------------------------------------------------

    const { data: platformAdmin, error: platformAdminError } =
      await admin
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();

    if (platformAdminError) {
      console.error(
        "Platform admin verification error:",
        platformAdminError,
      );

      return json(
        { error: "Unable to verify Platform Admin access." },
        500,
      );
    }

    if (!platformAdmin) {
      return json(
        { error: "Platform Admin access required." },
        403,
      );
    }

    // ---------------------------------------------------------
    // 4. Read requested action
    // ---------------------------------------------------------

    const body = await req.json();

    const action = String(body?.action || "").trim();

    // ---------------------------------------------------------
    // 5. LIST CHURCHES
    // Platform Admin only
    // ---------------------------------------------------------

    if (action === "list_churches") {
      const { data: churches, error: churchesError } =
        await admin
          .from("churches")
          .select("id,name,slug,website_url,trial_ends_at")
          .order("name", { ascending: true });

      if (churchesError) {
        console.error("Church list error:", churchesError);

        return json(
          { error: "Unable to load churches." },
          500,
        );
      }

      return json({
        success: true,
        churches: (churches || []).map(withTrialStatus),
      });
    }

    // All remaining actions require a church ID.

    const churchId = String(body?.churchId || "").trim();

    if (!churchId) {
      return json({ error: "Church ID is required." }, 400);
    }

    if (["dashboard", "dashboard_photo", "list_administrators", "invite_administrator", "resend_administrator"].includes(action)) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(churchId)) {
        return json({ error: "Invalid church ID." }, 400);
      }
      return await handlePlatformAction(admin, action, churchId, body);
    }

    if (
      action !== "update_church" &&
      action !== "clear_visitor_data" &&
      action !== "delete_church"
    ) {
      return json({ error: "Invalid management action." }, 400);
    }

    // Validate only the edit action; keep existing management behavior unchanged.
    let editValues: { name: string; website_url: string | null } | null = null;
    if (action === "update_church") {
      const allowedFields = ["action", "churchId", "name", "websiteUrl"];
      if (Object.keys(body).some((key) => !allowedFields.includes(key)) ||
          typeof body.name !== "string" || typeof body.websiteUrl !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(churchId)) {
        return json({ error: "Invalid church edit request." }, 400);
      }
      const name = body.name.trim();
      const website = body.websiteUrl.trim();
      if (!name || name.length > 200) {
        return json({ error: "Church name is required and must be 200 characters or fewer." }, 400);
      }
      if (website.length > 2048) {
        return json({ error: "Website must be 2,048 characters or fewer." }, 400);
      }
      if (website) {
        try {
          const url = new URL(website);
          if (!["https:", "http:"].includes(url.protocol) || !url.hostname ||
              url.username || url.password) throw new Error("Invalid website");
        } catch {
          return json({ error: "Enter a complete http:// or https:// website URL without login credentials, or leave it blank." }, 400);
        }
      }
      editValues = { name, website_url: website || null };
    }

    // Make sure the church exists.

    const { data: church, error: churchError } = await admin
      .from("churches")
      .select("id,name,slug")
      .eq("id", churchId)
      .maybeSingle();

    if (churchError) {
      console.error("Church lookup error:", churchError);
      return json({ error: "Unable to verify church." }, 500);
    }

    if (!church) {
      return json({ error: "Church not found." }, 404);
    }

    if (action === "update_church" && editValues) {
      // Never pass the request body to update: IDs, slugs, and billing are immutable here.
      const { data: updatedChurch, error: updateError } = await admin
        .from("churches")
        .update(editValues)
        .eq("id", churchId)
        .select("id,name,slug,website_url,trial_ends_at")
        .single();
      if (updateError || !updatedChurch) {
        console.error("Church update error:", updateError);
        return json({ error: "Unable to save church details. Please try again." }, 500);
      }
      return json({ success: true, church: updatedChurch });
    }

    // ---------------------------------------------------------
    // 6. CLEAR VISITOR DATA
    //
    // Keeps:
    // - church
    // - staff memberships
    //
    // Removes:
    // - visitor photos
    // - visitor records
    // ---------------------------------------------------------

    if (action === "clear_visitor_data") {
      try {
        const { data: files, error: listError } =
          await admin.storage
            .from("visitor-photos")
            .list(churchId, { limit: 1000 });

        if (listError) {
          console.error("Photo list error:", listError);
        } else if (files?.length) {
          const paths = files.map(
            (file) => `${churchId}/${file.name}`,
          );

          const { error: removeError } =
            await admin.storage
              .from("visitor-photos")
              .remove(paths);

          if (removeError) {
            console.error(
              "Visitor photo removal error:",
              removeError,
            );
          }
        }
      } catch (photoError) {
        console.error(
          "Visitor photo cleanup exception:",
          photoError,
        );
      }

      const { error: visitorDeleteError } = await admin
        .from("visitors")
        .delete()
        .eq("church_id", churchId);

      if (visitorDeleteError) {
        console.error(
          "Visitor deletion error:",
          visitorDeleteError,
        );

        return json(
          { error: "Unable to clear visitor data." },
          500,
        );
      }

      console.log(
        `Platform Admin ${user.id} cleared visitor data for ${church.name} (${church.id})`,
      );

      return json({
        success: true,
        action,
        churchId: church.id,
        churchName: church.name,
        message: `Visitor data cleared for ${church.name}.`,
      });
    }

    // ---------------------------------------------------------
    // 7. DELETE CHURCH
    //
    // Removes church-specific data but DOES NOT delete
    // Supabase Auth users.
    // ---------------------------------------------------------

    if (action === "delete_church") {
      const confirmation = String(
        body?.confirmation || "",
      ).trim();

      if (confirmation !== church.name) {
        return json(
          {
            error:
              "Church name confirmation does not match.",
          },
          400,
        );
      }

      // Remove visitor photos.

      try {
        const { data: files, error: listError } =
          await admin.storage
            .from("visitor-photos")
            .list(churchId, { limit: 1000 });

        if (listError) {
          console.error("Photo list error:", listError);
        } else if (files?.length) {
          const paths = files.map(
            (file) => `${churchId}/${file.name}`,
          );

          const { error: removeError } =
            await admin.storage
              .from("visitor-photos")
              .remove(paths);

          if (removeError) {
            console.error(
              "Visitor photo removal error:",
              removeError,
            );
          }
        }
      } catch (photoError) {
        console.error(
          "Visitor photo cleanup exception:",
          photoError,
        );
      }

      // Visitors first.

      const { error: visitorDeleteError } = await admin
        .from("visitors")
        .delete()
        .eq("church_id", churchId);

      if (visitorDeleteError) {
        console.error(
          "Visitor deletion error:",
          visitorDeleteError,
        );

        return json(
          { error: "Unable to remove church visitors." },
          500,
        );
      }

      // Remove church staff memberships.
      // Auth users themselves remain untouched.

      const { error: membershipDeleteError } = await admin
        .from("church_users")
        .delete()
        .eq("church_id", churchId);

      if (membershipDeleteError) {
        console.error(
          "Membership deletion error:",
          membershipDeleteError,
        );

        return json(
          { error: "Unable to remove church memberships." },
          500,
        );
      }

      // Finally remove the church.

      const { error: churchDeleteError } = await admin
        .from("churches")
        .delete()
        .eq("id", churchId);

      if (churchDeleteError) {
        console.error(
          "Church deletion error:",
          churchDeleteError,
        );

        return json(
          { error: "Unable to delete church." },
          500,
        );
      }

      console.log(
        `Platform Admin ${user.id} permanently deleted ${church.name} (${church.id})`,
      );

      return json({
        success: true,
        action,
        churchId,
        churchName: church.name,
        message: `${church.name} was deleted.`,
      });
    }

    return json({ error: "Invalid request." }, 400);
  } catch (error) {
    console.error("manage-church error:", error);

    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unexpected server error.",
      },
      500,
    );
  }
});

// Every call reaches this handler only after getUser(token) and platform_admins
// verification. Never accept an actor, role, slug, photo path, or redirect from clients.
async function handlePlatformAction(admin: any, action: string, churchId: string, body: any) {
  const { data: church, error: churchError } = await admin.from("churches")
    .select("id,name,slug,website_url,trial_ends_at").eq("id", churchId).maybeSingle();
  if (churchError) return json({ error: "Unable to load church." }, 500);
  if (!church) return json({ error: "Church not found." }, 404);
  if (action === "dashboard") {
    const visitors: any[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin.from("visitors").select("*")
        .eq("church_id", churchId).order("created_at", { ascending: false })
        .order("id", { ascending: false }).range(offset, offset + 999);
      if (error) return json({ error: "Unable to load church visitors." }, 500);
      visitors.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return json({ success: true, church: withTrialStatus(church), visitors });
  }
  if (action === "dashboard_photo") {
    if (typeof body.visitorId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.visitorId)) return json({ error: "Invalid visitor ID." }, 400);
    const { data: visitor, error } = await admin.from("visitors").select("id,photo_url")
      .eq("church_id", churchId).eq("id", body.visitorId).maybeSingle();
    if (error) return json({ error: "Unable to load visitor photo." }, 500);
    if (!visitor) return json({ error: "Visitor not found in selected church." }, 404);
    if (!visitor.photo_url) return json({ success: true, churchId, visitorId: visitor.id, signedUrl: null });
    if (!visitor.photo_url.startsWith(churchId + "/") || visitor.photo_url.includes("..")) return json({ error: "Invalid church photo path." }, 400);
    const result = await admin.storage.from("visitor-photos").createSignedUrl(visitor.photo_url, 300);
    if (result.error) return json({ error: "Unable to open visitor photo." }, 500);
    return json({ success: true, churchId, visitorId: visitor.id, signedUrl: result.data.signedUrl });
  }
  if (action === "list_administrators") {
    const { data, error } = await admin.from("church_users")
      .select("id,church_id,user_id,first_name,last_name,invited_email,invitation_status")
      .eq("church_id", churchId).eq("role", "admin").order("created_at", { ascending: true });
    if (error) return json({ error: "Unable to load church administrators." }, 500);
    return json({ success: true, churchId, administrators: data || [] });
  }
  const resend = action === "resend_administrator";
  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if ((!resend && (!firstName || firstName.length > 100 || !lastName || lastName.length > 100 ||
      email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) ||
      (resend && (typeof body.membershipId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.membershipId)))) {
    return json({ error: "Enter a valid name and email, or select a pending invitation." }, 400);
  }
  // Redirects must be explicitly configured when running outside production.
  const base = Deno.env.get("VISITOR_CONNECT_APP_URL") || "https://getvisitorconnect.com/";
  const redirect = new URL(base);
  if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1"].includes(redirect.hostname))) {
    return json({ error: "Invalid invitation redirect configuration." }, 500);
  }
  redirect.search = ""; redirect.hash = "";
  redirect.searchParams.set("church", church.slug);
  redirect.searchParams.set("admin_invitation", "1");
  const { data: reservation, error: reserveError } = await admin.rpc("prepare_platform_admin_invitation", {
    p_church_id: churchId, p_email: resend ? null : email,
    p_membership_id: resend ? body.membershipId : null, p_resend: resend,
  });
  if (reserveError || !reservation) return json({ error: reserveError?.message || "Unable to reserve invitation." }, 409);
  const finish = async (sent: boolean) => admin.rpc("finish_platform_admin_invitation", {
    p_church_id: churchId, p_email: reservation.email, p_token: reservation.token, p_sent: sent,
  });
  try {
    // Send first: inviting a newly-created account fails as already registered.
    // For existing confirmed accounts, use a sign-in link instead.
    let userId = reservation.userId;
    if (!userId) {
      const delivery = await admin.auth.admin.inviteUserByEmail(reservation.email, {
        redirectTo: redirect.toString(),
        data: { first_name: firstName, last_name: lastName },
      });
      if (delivery.error || !delivery.data?.user?.id) {
        throw new Error("Unable to send administrator invitation.");
      }
      userId = delivery.data.user.id;
    } else {
      const delivery = reservation.confirmed
        ? await admin.auth.signInWithOtp({ email: reservation.email, options: {
            shouldCreateUser: false, emailRedirectTo: redirect.toString(),
          } })
        : await admin.auth.admin.inviteUserByEmail(reservation.email, {
            redirectTo: redirect.toString(),
          });
      if (delivery.error) {
        throw new Error("Unable to send administrator invitation. Use Resend to retry.");
      }
    }
    if (!resend) {
      const attached = await admin.rpc("attach_platform_admin_invitation", {
        p_church_id: churchId, p_email: reservation.email, p_token: reservation.token,
        p_user_id: userId, p_first_name: firstName, p_last_name: lastName,
      });
      if (attached.error) {
        throw new Error("Invitation email sent but membership could not be attached. Contact support.");
      }
    }
    const completed = await finish(true);
    if (completed.error || completed.data !== true) {
      return json({ success: true, message: "Email sent. Delivery tracking needs attention; wait before resending." });
    }
    return json({ success: true, message: `${resend ? "Invitation resent" : "Administrator invitation sent"} to ${reservation.email}.` });
  } catch (error) {
    await finish(false);
    return json({ error: error instanceof Error ? error.message : "Invitation failed. Pending memberships were preserved." }, 500);
  }
}

// Fixed exclusive cutoff, after all of December 31 in America/Chicago.
function withTrialStatus(church: any) {
  return { ...church, trial_active: Date.parse(church.trial_ends_at) === Date.parse("2027-01-01T06:00:00Z") &&
    Date.now() < Date.parse("2027-01-01T06:00:00Z") };
}
