-- Additive only: existing churches remain undesignated; no billing/data backfill.
-- December 31 is inclusive in America/Chicago (exclusive UTC cutoff below).
BEGIN;
ALTER TABLE public.churches ADD COLUMN trial_ends_at timestamptz DEFAULT NULL
  CONSTRAINT churches_trial_cutoff CHECK (
    trial_ends_at IS NULL OR trial_ends_at = timestamptz '2027-01-01 06:00:00+00');

CREATE FUNCTION public.protect_church_trial() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.trial_ends_at IS NOT DISTINCT FROM OLD.trial_ends_at THEN RETURN NEW; END IF;
  ELSIF NEW.trial_ends_at IS NULL THEN RETURN NEW;
  END IF;
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform Administrator required' USING ERRCODE = '42501';
  END IF;
  IF NEW.trial_ends_at IS NOT NULL AND now() >= NEW.trial_ends_at THEN
    RAISE EXCEPTION 'Trial designation has expired' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_church_trial() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER protect_church_trial BEFORE INSERT OR UPDATE OF trial_ends_at
  ON public.churches FOR EACH ROW EXECUTE FUNCTION public.protect_church_trial();

-- Caller-scoped, atomic trial creation. No existing church is designated or changed.
CREATE FUNCTION public.platform_create_trial_church(p_name text,p_website_url text,p_slug text)
RETURNS TABLE(id uuid,name text,slug text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform Administrator required' USING ERRCODE='42501';
  END IF;
  IF statement_timestamp() >= timestamptz '2027-01-01 06:00:00+00' THEN
    RAISE EXCEPTION 'Trial creation has ended' USING ERRCODE='22023';
  END IF;
  IF nullif(btrim(p_name),'') IS NULL OR nullif(btrim(p_slug),'') IS NULL THEN
    RAISE EXCEPTION 'Church name and registration link required';
  END IF;
  IF EXISTS(SELECT 1 FROM public.churches c WHERE lower(c.slug)=lower(btrim(p_slug))) THEN
    RAISE EXCEPTION 'That church registration URL is already in use';
  END IF;
  RETURN QUERY INSERT INTO public.churches AS c(name,website_url,slug,trial_ends_at)
    VALUES(btrim(p_name),nullif(btrim(p_website_url),''),lower(btrim(p_slug)),timestamptz '2027-01-01 06:00:00+00')
    RETURNING c.id,c.name,c.slug;
END;
$$;
REVOKE ALL ON FUNCTION public.platform_create_trial_church(text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.platform_create_trial_church(text,text,text) TO authenticated;

-- A database-time gate, not a browser date or a JWT entitlement claim.
CREATE FUNCTION public.trial_access_allowed(target_church_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.is_platform_admin() OR EXISTS (
    SELECT 1 FROM public.churches c WHERE c.id=target_church_id
      AND (c.trial_ends_at IS NULL OR statement_timestamp() < c.trial_ends_at)
  );
$$;
REVOKE ALL ON FUNCTION public.trial_access_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trial_access_allowed(uuid) TO anon,authenticated,service_role;

-- The caller may read only their own access state. Existing membership role
-- semantics remain intact; unrelated membership/security refactoring is excluded.
CREATE FUNCTION public.my_church_access(target_church_id uuid)
RETURNS TABLE(church_id uuid,church_name text,role text,access_allowed boolean,trial_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.id,c.name,cu.role,public.trial_access_allowed(c.id),
    c.trial_ends_at IS NOT NULL AND statement_timestamp() < c.trial_ends_at
  FROM public.churches c JOIN public.church_users cu ON cu.church_id=c.id
  WHERE c.id=target_church_id AND cu.user_id=auth.uid()
    AND cu.role IN ('admin','outreach','greeter','media');
$$;
REVOKE ALL ON FUNCTION public.my_church_access(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.my_church_access(uuid) TO authenticated;

-- Keep the existing role semantics; add only the trial entitlement condition.
CREATE OR REPLACE FUNCTION public.has_church_role(target_church_id uuid, allowed_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.trial_access_allowed(target_church_id) AND EXISTS (
    SELECT 1 FROM public.church_users WHERE user_id=auth.uid()
      AND church_id=target_church_id AND role=ANY(allowed_roles));
$$;
CREATE OR REPLACE FUNCTION public.is_church_admin(target_church_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.trial_access_allowed(target_church_id) AND EXISTS (
    SELECT 1 FROM public.church_users WHERE user_id=auth.uid()
      AND church_id=target_church_id AND role='admin');
$$;

-- RESTRICTIVE policies AND with every permissive grant. Registration INSERTs
-- deliberately remain available; an expired trial must not lose visitor records.
CREATE POLICY trial_visitor_read ON public.visitors AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.trial_access_allowed(church_id));
CREATE POLICY trial_visitor_update ON public.visitors AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.trial_access_allowed(church_id)) WITH CHECK (public.trial_access_allowed(church_id));
CREATE POLICY trial_visitor_delete ON public.visitors AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.trial_access_allowed(church_id));
CREATE POLICY trial_church_access ON public.churches AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.trial_access_allowed(id)) WITH CHECK (public.trial_access_allowed(id));
CREATE POLICY trial_staff_read ON public.church_users AS RESTRICTIVE FOR SELECT TO authenticated
  USING (user_id=auth.uid() OR public.trial_access_allowed(church_id));
CREATE POLICY trial_staff_insert ON public.church_users AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.trial_access_allowed(church_id));
CREATE POLICY trial_staff_update ON public.church_users AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.trial_access_allowed(church_id)) WITH CHECK (public.trial_access_allowed(church_id));
CREATE POLICY trial_staff_delete ON public.church_users AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.trial_access_allowed(church_id));
-- The existing Storage SELECT policy calls has_church_role(), now gated above.
-- Existing get_greeter_visitors/get_media_welcome_visitors also call that helper.
-- Active trial users must not mint long-lived Storage capabilities that survive
-- the cutoff. Serve their photos via the authenticated, no-store Edge proxy.
CREATE FUNCTION public.trial_direct_photo_allowed(object_name text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE folder_id uuid;
BEGIN
  IF public.is_platform_admin() THEN RETURN true; END IF;
  BEGIN
    folder_id := split_part(object_name,'/',1)::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RETURN false;
  END;
  RETURN NOT EXISTS (SELECT 1 FROM public.churches c
    WHERE c.id=folder_id AND c.trial_ends_at IS NOT NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.trial_direct_photo_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trial_direct_photo_allowed(text) TO authenticated;
CREATE POLICY trial_photo_capabilities ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated
  USING (bucket_id <> 'visitor-photos' OR public.trial_direct_photo_allowed(name));

CREATE OR REPLACE FUNCTION public.remove_church_staff(target_church_id uuid,target_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.trial_access_allowed(target_church_id) THEN
    RAISE EXCEPTION 'Trial Account expired' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.church_users WHERE church_id=target_church_id
      AND user_id=auth.uid() AND role='admin' AND invitation_status='active') THEN
    RAISE EXCEPTION 'Only an active church administrator can remove staff.';
  END IF;
  IF target_user_id=auth.uid() THEN RAISE EXCEPTION 'You cannot remove your own administrator access.'; END IF;
  DELETE FROM public.church_users WHERE church_id=target_church_id AND user_id=target_user_id;
  RETURN FOUND;
END;
$$;

-- RLS does not govern TRUNCATE; remove this API bypass explicitly.
REVOKE TRUNCATE ON public.churches,public.church_users,public.visitors FROM PUBLIC,anon,authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM (VALUES ('anon'),('authenticated')) r(role_name)
    CROSS JOIN (VALUES ('public.churches'),('public.church_users'),('public.visitors')) t(table_name)
    WHERE has_table_privilege(r.role_name,t.table_name,'TRUNCATE')) THEN
    RAISE EXCEPTION 'Inherited TRUNCATE privileges remain; migration must not proceed';
  END IF;
END $$;

COMMIT;
