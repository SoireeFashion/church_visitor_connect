import { createClient } from "npm:@supabase/supabase-js@2";
import { createSupabaseContext } from "npm:@supabase/server@1";
import { corsHeaders } from "npm:@supabase/supabase-js@^2/cors";

interface CreateChurchPayload {
  churchName: string;
  websiteUrl?: string;
  isTrial?: boolean;
  slug: string;
  adminFirstName: string;
  adminLastName: string;
  adminEmail: string;
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders
  });
}

export default {
  fetch: async (req: Request) => {

    if (req.method === "OPTIONS") {
      return new Response("ok", {
        status: 200,
        headers: corsHeaders
      });
    }

    try {
      // Authenticate the signed-in Visitor Connect user.
      const { data: ctx, error: authError } =
        await createSupabaseContext(req, {
          auth: "user"
        });

      if (authError || !ctx) {
        console.error("AUTH ERROR:", authError);

        return json(
          {
            error: authError?.message || "Authentication required.",
            stage: "authentication"
          },
          authError?.status || 401
        );
      }

      const userId = ctx.userClaims?.id;

      if (!userId) {
        return json(
          {
            error: "Authenticated user ID was not found.",
            stage: "authentication"
          },
          401
        );
      }

      // Confirm this user is a Visitor Connect Platform Administrator.
      const { data: platformAdmin, error: platformError } =
        await ctx.supabase.rpc("is_platform_admin");

      if (platformError) {
        console.error("PLATFORM ADMIN CHECK ERROR:", platformError);

        return json(
          {
            error: platformError.message,
            stage: "platform-admin-check"
          },
          500
        );
      }

      if (platformAdmin !== true) {
        return json(
          {
            error: "Platform administrator access required.",
            stage: "platform-admin-check"
          },
          403
        );
      }

      // Create a privileged server-side client.
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS");

      if (!supabaseUrl || !secretKeysJson) {
        return json(
          {
            error: "Supabase server credentials are unavailable.",
            stage: "server-configuration"
          },
          500
        );
      }

      let secretKeys: Record<string, string>;

      try {
        secretKeys = JSON.parse(secretKeysJson);
      } catch {
        return json(
          {
            error: "Supabase server credentials could not be read.",
            stage: "server-configuration"
          },
          500
        );
      }

      const secretKey =
        secretKeys.default ||
        Object.values(secretKeys)[0];

      if (!secretKey) {
        return json(
          {
            error: "No Supabase secret key is configured for this function.",
            stage: "server-configuration"
          },
          500
        );
      }

      const supabaseAdmin = createClient(
        supabaseUrl,
        secretKey,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
          }
        }
      );

      // Read form information.
      const body: CreateChurchPayload = await req.json();

      if (body.isTrial !== undefined && typeof body.isTrial !== "boolean") {
        return json({ error: "Trial Account must be true or false.", stage: "validation" }, 400);
      }
      const churchName = body.churchName?.trim();
      const websiteUrl = body.websiteUrl?.trim() || null;
      const slug = body.slug?.trim().toLowerCase();
      const adminFirstName = body.adminFirstName?.trim();
      const adminLastName = body.adminLastName?.trim();
      const adminEmail = body.adminEmail?.trim().toLowerCase();

      if (
        !churchName ||
        !slug ||
        !adminFirstName ||
        !adminLastName ||
        !adminEmail
      ) {
        return json(
          {
            error: "Please complete all required fields.",
            stage: "validation"
          },
          400
        );
      }

      // Make sure the registration URL is unique.
      const { data: existingChurch, error: lookupError } =
        await supabaseAdmin
          .from("churches")
          .select("id")
          .eq("slug", slug)
          .maybeSingle();

      if (lookupError) {
        console.error("CHURCH LOOKUP ERROR:", lookupError);

        return json(
          {
            error: lookupError.message,
            stage: "church-lookup"
          },
          500
        );
      }

      if (existingChurch) {
        return json(
          {
            error: "That church registration URL is already in use.",
            stage: "church-lookup"
          },
          409
        );
      }

      // Trial creation uses the verified caller JWT so the database independently
      // checks Platform Administrator authority and fixes the expiry atomically.
      // The existing nontrial creation path remains unchanged.
      const result = body.isTrial === true
        ? await ctx.supabase.rpc("platform_create_trial_church", {
            p_name: churchName, p_website_url: websiteUrl, p_slug: slug,
          })
        : await supabaseAdmin.from("churches").insert({
            name: churchName, website_url: websiteUrl, slug,
          }).select("id, name, slug").single();
      const church = body.isTrial === true ? result.data?.[0] : result.data;
      const churchError = result.error;

      if (churchError || !church) {
        console.error("CHURCH CREATE ERROR:", churchError);

        return json(
          {
            error: churchError?.message || "Unable to create church.",
            stage: "church-create"
          },
          500
        );
      }

      // Invite first Church Administrator.
      // Redirect the administrator back to their specific church.
      const { data: inviteData, error: inviteError } =
        await supabaseAdmin.auth.admin.inviteUserByEmail(
          adminEmail,
          {
            data: {
              first_name: adminFirstName,
              last_name: adminLastName,
              church_id: church.id,
              church_role: "admin",
              church_slug: church.slug
            },
            redirectTo:
              `https://soireefashion.github.io/church_visitor_connect/?church=${encodeURIComponent(church.slug)}`
          }
        );

      if (inviteError || !inviteData?.user) {
        console.error("ADMIN INVITE ERROR:", inviteError);

        await supabaseAdmin
          .from("churches")
          .delete()
          .eq("id", church.id);

        return json(
          {
            error:
              inviteError?.message ||
              "Administrator invitation failed.",
            stage: "administrator-invite"
          },
          500
        );
      }

      // Create administrator membership.
      const { error: membershipError } =
        await supabaseAdmin
          .from("church_users")
          .insert({
            church_id: church.id,
            user_id: inviteData.user.id,
            role: "admin",
            first_name: adminFirstName,
            last_name: adminLastName,
            invited_email: adminEmail,
            invitation_status: "invited"
          });

      if (membershipError) {
        console.error("MEMBERSHIP ERROR:", membershipError);

        await supabaseAdmin
          .from("churches")
          .delete()
          .eq("id", church.id);

        await supabaseAdmin.auth.admin.deleteUser(
          inviteData.user.id
        );

        return json(
          {
            error: membershipError.message,
            stage: "membership-create"
          },
          500
        );
      }

      return json({
        success: true,
        church: {
          id: church.id,
          name: church.name,
          slug: church.slug
        },
        administrator: {
          email: adminEmail,
          invitationStatus: "invited"
        }
      });

    } catch (error) {
      console.error("UNEXPECTED CREATE CHURCH ERROR:", error);

      return json(
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
          stage: "unexpected"
        },
        500
      );
    }
  }
};
