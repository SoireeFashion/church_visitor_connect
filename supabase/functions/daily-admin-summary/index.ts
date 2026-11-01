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
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    if (!serviceRoleKey) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
    }

    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY is not configured.");
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    // Get all churches.
    const { data: churches, error: churchesError } = await admin
      .from("churches")
      .select("id, name, slug");

    if (churchesError) {
      throw churchesError;
    }

    if (!churches || churches.length === 0) {
      return jsonResponse({
        success: true,
        churchesProcessed: 0,
        emailsSent: 0,
        message: "No churches found.",
      });
    }

    let churchesProcessed = 0;
    let emailsSent = 0;

    const results: any[] = [];

    for (const church of churches) {
      const { data: allowed, error: gateError } = await admin.rpc("trial_access_allowed", { target_church_id: church.id });
      if (gateError || allowed !== true) continue;

      /*
       * V1 currently operates in Central Time.
       * We use the Central-Time calendar date for the daily report.
       * This can later become a per-church timezone setting.
       */
      const now = new Date();

      const centralDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);

      const startCentral = new Date(
        `${centralDate}T00:00:00-05:00`,
      );

      const endCentral = new Date(
        `${centralDate}T23:59:59.999-05:00`,
      );

      // Get today's visitors for this church.
      const { data: visitors, error: visitorsError } = await admin
        .from("visitors")
        .select("id, visit_type, created_at")
        .eq("church_id", church.id)
        .gte("created_at", startCentral.toISOString())
        .lte("created_at", endCentral.toISOString());

      if (visitorsError) {
        console.error(
          `Visitor query failed for ${church.name}:`,
          visitorsError,
        );

        results.push({
          church: church.name,
          success: false,
          error: visitorsError.message,
        });

        continue;
      }

      const totalVisitors = visitors?.length || 0;

      const firstTimeVisitors =
        visitors?.filter((visitor) => {
          const type = String(visitor.visit_type || "")
            .trim()
            .toLowerCase();

          return (
            type === "first time" ||
            type === "first-time" ||
            type === "first_time"
          );
        }).length || 0;

      const returningVisitors =
        visitors?.filter((visitor) => {
          const type = String(visitor.visit_type || "")
            .trim()
            .toLowerCase();

          return (
            type === "returning" ||
            type === "returning visitor" ||
            type === "return"
          );
        }).length || 0;

      // Find active Admin/Pastor users for this church.
      const { data: churchAdmins, error: adminsError } = await admin
        .from("church_users")
        .select(
          "user_id, first_name, last_name, invited_email, role, invitation_status",
        )
        .eq("church_id", church.id)
        .eq("role", "admin")
        .eq("invitation_status", "active");

      if (adminsError) {
        console.error(
          `Admin query failed for ${church.name}:`,
          adminsError,
        );

        results.push({
          church: church.name,
          success: false,
          error: adminsError.message,
        });

        continue;
      }

      const recipients = [
        ...new Set(
          (churchAdmins || [])
            .map((user) => user.invited_email)
            .filter(
              (email) =>
                typeof email === "string" &&
                email.includes("@"),
            ),
        ),
      ];

      if (recipients.length === 0) {
        results.push({
          church: church.name,
          success: true,
          totalVisitors,
          firstTimeVisitors,
          returningVisitors,
          emailsSent: 0,
          message: "No active Admin/Pastor email addresses found.",
        });

        churchesProcessed++;
        continue;
      }

      const displayDate = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(now);

      let churchEmailsSent = 0;

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
                `Daily Visitor Summary — ${church.name}`,

              html: `
                <div style="
                  font-family:Arial,sans-serif;
                  max-width:600px;
                  margin:0 auto;
                  color:#222;
                ">

                  <h2 style="margin-bottom:8px;">
                    Daily Visitor Summary
                  </h2>

                  <p style="
                    font-size:18px;
                    margin-top:0;
                  ">
                    <strong>${church.name}</strong><br>
                    ${displayDate}
                  </p>

                  <div style="
                    background:#f5f5f5;
                    padding:24px;
                    border-radius:8px;
                    margin:24px 0;
                  ">

                    <div style="
                      font-size:32px;
                      font-weight:bold;
                      margin-bottom:20px;
                    ">
                      ${totalVisitors}
                      ${
                        totalVisitors === 1
                          ? "Visitor Today"
                          : "Visitors Today"
                      }
                    </div>

                    <p style="
                      font-size:17px;
                      margin:8px 0;
                    ">
                      <strong>First-Time Visitors:</strong>
                      ${firstTimeVisitors}
                    </p>

                    <p style="
                      font-size:17px;
                      margin:8px 0;
                    ">
                      <strong>Returning Visitors:</strong>
                      ${returningVisitors}
                    </p>

                  </div>

                  <p>
                    Your visitor records and follow-up activity
                    are available in Visitor Connect.
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
            `Daily summary email failed for ${email}:`,
            errorText,
          );

          continue;
        }

        churchEmailsSent++;
        emailsSent++;
      }

      churchesProcessed++;

      results.push({
        church: church.name,
        success: true,
        totalVisitors,
        firstTimeVisitors,
        returningVisitors,
        emailsSent: churchEmailsSent,
      });
    }

    console.log("Daily admin summary complete:", results);

    return jsonResponse({
      success: true,
      churchesProcessed,
      emailsSent,
      results,
    });
  } catch (error) {
    console.error("daily-admin-summary error:", error);

    return jsonResponse(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
      400,
    );
  }
});

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
