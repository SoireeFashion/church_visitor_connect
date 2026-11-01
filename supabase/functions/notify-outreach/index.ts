import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SECRET_KEYS");

    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    if (!serviceRoleKey) {
      throw new Error("Supabase service role key is not configured.");
    }

    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY is not configured.");
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json();

    const churchId = body.churchId;

    // register_visitor may return either the UUID itself or an object.
    const rawVisitorId = body.visitorId;

    const visitorId =
      typeof rawVisitorId === "string"
        ? rawVisitorId
        : rawVisitorId?.id ||
          rawVisitorId?.visitor_id ||
          rawVisitorId?.register_visitor ||
          null;

    console.log("notify-outreach request:", {
      rawVisitorId,
      visitorId,
      churchId,
    });

    if (!visitorId || !churchId) {
      throw new Error("Valid visitorId and churchId are required.");
    }

    const { data: allowed, error: gateError } = await admin.rpc("trial_access_allowed", { target_church_id: churchId });
    if (gateError || allowed !== true) return new Response(JSON.stringify({ error: "Trial Account expired" }), {
      status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

    // Find the newly registered visitor.
    const { data: visitor, error: visitorError } = await admin
      .from("visitors")
      .select("*")
      .eq("id", visitorId)
      .maybeSingle();

    if (visitorError) {
      console.error("Visitor lookup error:", visitorError);
      throw visitorError;
    }

    if (!visitor) {
      throw new Error(`Visitor not found for ID: ${visitorId}`);
    }

    // Extra tenant safety check.
    if (visitor.church_id !== churchId) {
      throw new Error("Visitor does not belong to this church.");
    }

    // Only notify Outreach when permission was given.
    if (visitor.contact_permission !== true) {
      return new Response(
        JSON.stringify({
          success: true,
          notified: 0,
          message: "Visitor did not give follow-up permission.",
        }),
        {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Get church information.
    const { data: church, error: churchError } = await admin
      .from("churches")
      .select("id, name, slug")
      .eq("id", churchId)
      .single();

    if (churchError || !church) {
      throw new Error("Church not found.");
    }

    // Find active Outreach staff assigned to this church.
    const { data: outreachUsers, error: outreachError } = await admin
      .from("church_users")
      .select("user_id, first_name, last_name, invited_email")
      .eq("church_id", churchId)
      .eq("role", "outreach")
      .eq("invitation_status", "active");

    if (outreachError) {
      throw outreachError;
    }

    if (!outreachUsers || outreachUsers.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          notified: 0,
          message: "No active Outreach staff found.",
        }),
        {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const recipients = [
      ...new Set(
        outreachUsers
          .map((user) => user.invited_email)
          .filter(
            (email) =>
              typeof email === "string" &&
              email.includes("@")
          ),
      ),
    ];

    if (recipients.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          notified: 0,
          message: "No Outreach email addresses found.",
        }),
        {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const visitorName =
      [visitor.first_name, visitor.last_name]
        .filter(Boolean)
        .join(" ")
        .trim() || "A visitor";

    const visitType =
      visitor.visit_type || "Visitor";

    const visitDate = new Date(
      visitor.created_at || new Date().toISOString(),
    ).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    let notified = 0;

    for (const email of recipients) {
      const response = await fetch(
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from:
              "Visitor Connect <editor@soireefashionmagazine.com>",

            to: [email],

            subject:
              `New Visitor Follow-Up Needed — ${church.name}`,

            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222;">

                <h2>New Visitor Follow-Up Needed</h2>

                <p>
                  A visitor at
                  <strong>${church.name}</strong>
                  has requested follow-up.
                </p>

                <div style="
                  background:#f5f5f5;
                  padding:18px;
                  border-radius:8px;
                  margin:20px 0;
                ">

                  <p>
                    <strong>Visitor:</strong>
                    ${visitorName}
                  </p>

                  <p>
                    <strong>Visit:</strong>
                    ${visitType}
                  </p>

                  <p>
                    <strong>Date:</strong>
                    ${visitDate}
                  </p>

                </div>

                <p>
                  Sign in to Visitor Connect to view the
                  visitor's information and complete follow-up.
                </p>

                <p style="margin-top:28px;">
                  <strong>Visitor Connect</strong><br>
                  <span style="color:#666;">
                    From first visit to meaningful follow-up.
                  </span>
                </p>

              </div>
            `,
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();

        console.error(
          `Resend failed for ${email}:`,
          errorText,
        );

        continue;
      }

      notified++;
    }

    console.log(
      `Outreach notification complete. Sent: ${notified}`,
    );

    return new Response(
      JSON.stringify({
        success: true,
        notified,
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );

  } catch (error) {
    console.error("notify-outreach error:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error",
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
