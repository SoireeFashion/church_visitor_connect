import { createClient } from "npm:@supabase/supabase-js@2";
import { createSupabaseContext } from "npm:@supabase/server@1";
import { corsHeaders } from "npm:@supabase/supabase-js@^2/cors";

interface InviteStaffPayload {
  firstName: string;
  lastName: string;
  email: string;
  role: "admin" | "greeter" | "outreach" | "media";
  churchId: string;
  churchSlug: string;
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
      // ---------------------------------------------------------
      // 1. Authenticate the person making the request
      // ---------------------------------------------------------

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

      const requestingUserId = ctx.userClaims?.id;

      if (!requestingUserId) {
        return json(
          {
            error: "Authenticated user ID was not found.",
            stage: "authentication"
          },
          401
        );
      }

      // ---------------------------------------------------------
      // 2. Read and validate request
      // ---------------------------------------------------------

      const body: InviteStaffPayload = await req.json();

      const firstName = body.firstName?.trim();
      const lastName = body.lastName?.trim();
      const email = body.email?.trim().toLowerCase();
      const role = body.role?.trim().toLowerCase();
      const churchId = body.churchId?.trim();
      const churchSlug = body.churchSlug?.trim().toLowerCase();

      const allowedRoles = [
        "admin",
        "greeter",
        "outreach",
        "media"
      ];

      if (
        !firstName ||
        !lastName ||
        !email ||
        !role ||
        !churchId ||
        !churchSlug
      ) {
        return json(
          {
            error: "Please complete all required fields.",
            stage: "validation"
          },
          400
        );
      }

      if (!allowedRoles.includes(role)) {
        return json(
          {
            error: "That staff role is not valid.",
            stage: "validation"
          },
          400
        );
      }

      // ---------------------------------------------------------
      // 3. Verify this user is an ADMIN of THIS church
      // ---------------------------------------------------------

      const { data: membership, error: membershipLookupError } =
        await ctx.supabase
          .from("church_users")
          .select("church_id, role")
          .eq("user_id", requestingUserId)
          .eq("church_id", churchId)
          .maybeSingle();

      if (membershipLookupError) {
        console.error(
          "ADMIN MEMBERSHIP LOOKUP ERROR:",
          membershipLookupError
        );

        return json(
          {
            error: membershipLookupError.message,
            stage: "admin-access-check"
          },
          500
        );
      }

      if (!membership || membership.role !== "admin") {
        return json(
          {
            error:
              "Church administrator access is required to invite staff.",
            stage: "admin-access-check"
          },
          403
        );
      }

      // Caller-scoped gate must run before creating Auth invitations or using
      // service credentials, which bypass database RLS.
      const { data: access, error: accessError } = await ctx.supabase.rpc(
        "my_church_access", { target_church_id: churchId }
      );
      if (accessError || !access?.[0]?.access_allowed) {
        return json({ error: "Trial Account expired", stage: "trial-access-check" }, 403);
      }

      // ---------------------------------------------------------
      // 4. Get secure Supabase server credentials
      // ---------------------------------------------------------

      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const secretKeysJson =
        Deno.env.get("SUPABASE_SECRET_KEYS");

      if (!supabaseUrl || !secretKeysJson) {
        return json(
          {
            error:
              "Supabase server credentials are unavailable.",
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
            error:
              "Supabase server credentials could not be read.",
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
            error:
              "No Supabase secret key is configured for this function.",
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

      // ---------------------------------------------------------
      // 5. Verify church exists and slug matches
      // ---------------------------------------------------------

      const { data: church, error: churchError } =
        await supabaseAdmin
          .from("churches")
          .select("id, name, slug")
          .eq("id", churchId)
          .eq("slug", churchSlug)
          .maybeSingle();

      if (churchError) {
        console.error("CHURCH LOOKUP ERROR:", churchError);

        return json(
          {
            error: churchError.message,
            stage: "church-lookup"
          },
          500
        );
      }

      if (!church) {
        return json(
          {
            error: "The selected church could not be found.",
            stage: "church-lookup"
          },
          404
        );
      }

      // ---------------------------------------------------------
      // 6. Invite the staff member
      // ---------------------------------------------------------

      const { data: inviteData, error: inviteError } =
        await supabaseAdmin.auth.admin.inviteUserByEmail(
          email,
          {
            data: {
              first_name: firstName,
              last_name: lastName,
              church_id: church.id,
              church_role: role,
              church_slug: church.slug
            },

            // Production Visitor Connect URL.
            redirectTo:
              `https://soireefashion.github.io/church_visitor_connect/?church=${encodeURIComponent(
                church.slug
              )}`
          }
        );

      if (inviteError || !inviteData?.user) {
        console.error("STAFF INVITE ERROR:", inviteError);

        return json(
          {
            error:
              inviteError?.message ||
              "Staff invitation could not be sent.",
            stage: "staff-invite"
          },
          500
        );
      }

      const invitedUser = inviteData.user;

      // ---------------------------------------------------------
      // 7. Prevent duplicate membership
      // ---------------------------------------------------------

      const { data: existingMembership, error: duplicateError } =
        await supabaseAdmin
          .from("church_users")
          .select("user_id, church_id")
          .eq("user_id", invitedUser.id)
          .eq("church_id", church.id)
          .maybeSingle();

      if (duplicateError) {
        console.error(
          "MEMBERSHIP DUPLICATE CHECK ERROR:",
          duplicateError
        );

        return json(
          {
            error: duplicateError.message,
            stage: "membership-check"
          },
          500
        );
      }

      if (existingMembership) {
        return json(
          {
            error:
              "This person is already a staff member of this church.",
            stage: "membership-check"
          },
          409
        );
      }

      // ---------------------------------------------------------
      // 8. Create church membership
      // ---------------------------------------------------------

      const { error: membershipError } =
        await supabaseAdmin
          .from("church_users")
          .insert({
            church_id: church.id,
            user_id: invitedUser.id,
            role,
            first_name: firstName,
            last_name: lastName,
            invited_email: email,
            invitation_status: "invited"
          });

      if (membershipError) {
        console.error(
          "STAFF MEMBERSHIP CREATE ERROR:",
          membershipError
        );

        // Remove newly-created Auth invitation if membership fails.
        await supabaseAdmin.auth.admin.deleteUser(
          invitedUser.id
        );

        return json(
          {
            error: membershipError.message,
            stage: "membership-create"
          },
          500
        );
      }

      // ---------------------------------------------------------
      // 9. Success
      // ---------------------------------------------------------

      return json({
        success: true,

        church: {
          id: church.id,
          name: church.name,
          slug: church.slug
        },

        staff: {
          userId: invitedUser.id,
          firstName,
          lastName,
          email,
          role,
          invitationStatus: "invited"
        }
      });

    } catch (error) {
      console.error(
        "UNEXPECTED INVITE STAFF ERROR:",
        error
      );

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
