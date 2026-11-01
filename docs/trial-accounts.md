# Limited Trial Account release — local review

Worktree: `/private/tmp/visitor-connect-trial-account`, branch `codex/trial-accounts`.
Frontend baseline: production-main `4934412f482960262968830b535c3af20170bb74`.
Server baselines retrieved read-only: manage-church v4, create-church v13,
invite-church-staff v5, notify-outreach v6, daily-admin-summary v3.

## Limited behavior

- Only Platform Administration's existing Create Church form offers Trial Account.
  It is unchecked by default. Existing church cards have no trial-conversion action.
- Trial creation uses the caller's verified JWT and a Platform-only database RPC.
  The church and fixed trial date are inserted atomically, before inviting staff.
  Nontrial creation follows its existing server path. No browser can supply a date.
- Full authorized access lasts through December 31, 2026, America/Chicago. The
  exclusive database-time cutoff is `2027-01-01T06:00:00Z`.
- A simple Trial Account label is shown while active, without a countdown.
- After cutoff, staff dashboard entry/rendering fails closed. RLS restricts direct
  visitor SELECT/UPDATE/DELETE, staff administration and protected church access.
  Existing role helpers gate greeter/media RPCs and Storage access; the definer
  remove_church_staff RPC has an explicit expiration guard. Service-backed staff
  invitations, outreach notifications and summary delivery also check the gate.
- New trial photo reads use an authenticated, no-store byte proxy. A restrictive
  Storage policy prevents trial members minting signed capabilities before cutoff.
  Only NEW churches are made trials, so existing staff-signed URLs for existing
  nontrial churches do not create a trial-expiration exposure in this release.
  Trusted Platform access and its existing photo workflow remain unchanged.
- Expired churches see a short access-unavailable message and can contact Platform
  Administration. There is no payment screen, continuation flow or automatic
  paid restoration in this limited proposal.
- Platform Administrator management remains available. Public visitor registration,
  photo uploads, recovery membership reads, existing church IDs/slugs/links and
  all stored records remain intact. No expiration deletes or deactivates records.
- The initial signup checkout submit handler is byte-for-byte unchanged from main.
  Existing production Stripe functions are untouched.

## Exact intended file inventory

Updated/added relative to the production-main baseline (all paths share
`/private/tmp/visitor-connect-trial-account/`):

1. `index.html`
2. `supabase/config.toml`
3. `supabase/migrations/20261101205119_platform_trial_accounts.sql`
4. `supabase/functions/create-church/index.ts`
5. `supabase/functions/manage-church/index.ts`
6. `supabase/functions/invite-church-staff/index.ts`
7. `supabase/functions/notify-outreach/index.ts`
8. `supabase/functions/daily-admin-summary/index.ts`
9. `supabase/functions/church-visitor-photo/index.ts`
10. `supabase/functions/_shared/server.ts`
11. `supabase/functions/deno.lock`
12. `tests/trial-accounts.mjs`
13. `docs/trial-accounts.md`

Removed from the prior uncommitted proposal:

- `supabase/functions/continued-subscription/index.ts`
- `supabase/functions/trial-subscription-webhook/index.ts`
- `supabase/functions/_shared/trial-billing.ts`
- `supabase/migrations/20261101210156_enforce_trial_subscription.sql`
- `tests/trial-enforcement.mjs`

The remaining migration contains no payment ledger or subscription logic. It adds
one nullable trial column without backfill, a guarded creation RPC/trigger, access
helpers and RESTRICTIVE policies; existing permissive policies are retained.
It revokes effective browser-role TRUNCATE privileges on the three church tables
because TRUNCATE bypasses RLS, and aborts if inherited grants remain. Public API
roles cannot change trial designations; only Platform authority can do so.

## Verification

Focused suite: **25 passed, 0 failed**. This includes actual migration application
against an isolated PGlite SQL schema with synthetic rows and representative
inspected RLS policies. AFTER applying the unmodified migration, tests substitute
only clock expressions inside that isolated database to exercise the exact cutoff;
no production time hooks or test credentials are present in application code.

Checks cover authorized trial creation, ordinary-admin rejection, failed creation
without invitations, default nontrial creation, duplicate registration slugs,
December 31 access, January 1 SQL denial, administrative RPC denial, retained
Platform access, public registration, existing nontrial visitor access, isolation,
private photo policies, TRUNCATE removal and unchanged stored visitor data.
Creation Edge requests and frontend DOM tests use mocks; these are not Supabase
HTTP integration tests. Anonymous public registration is tested as a direct SQL
insert under the preserved INSERT policy, not a complete browser submission.

Commands:

```
node tests/trial-accounts.mjs /tmp/visitor-connect-edit-tests/node_modules /tmp/visitor-connect-security-tests/node_modules
node /private/tmp/visitor-connect-superadmin/tests/edit-church.mjs /tmp/visitor-connect-edit-tests/node_modules
```

Edit Church regression suite: **30 passed, 0 failed** against this branch's source.
Deno checks pass for all six relevant Edge Functions, with the dependency lock.
Inline scripts parse and git diff --check passes.

## Deployment readiness

**Not yet verified ready to deploy.** The remaining relevant blocker is a real
isolated Supabase/browser rehearsal: apply this ONE migration to a synthetic test
project, deploy the six compatible functions THERE with existing JWT settings,
and test Auth, Create Church invitation/membership completion, direct REST/RPC
requests, private Storage and the registration browser flow. The SQL fixture does
not verify Supabase API grants, actual Auth context propagation or Storage gateway
behavior. No identified isolated Supabase project/local stack is currently available.

Before a separately approved production release, recheck source/schema drift and
recoverable database/Storage backups. Coordinate migration, Edge Functions and
frontend; frontend must not precede its new RPCs. Existing create-church v13's
verify_jwt=false is preserved because its server context verifies the caller and
Platform role; manage-church and photo endpoint retain JWT verification.
Older frontends cannot fetch trial photos after the new signing restriction.

No production data, policies, functions or deployments were modified. No Git commit,
push or merge was made. Only the isolated in-memory SQL fixture ran migrations.
Phase 1 and the completed SuperAdmin worktree remain untouched.
