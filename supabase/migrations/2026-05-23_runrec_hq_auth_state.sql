-- RunRec HQ — Auth + notification schema, reconciled to LIVE production state.
--
-- WHY THIS FILE EXISTS:
-- The earlier migration (2026-05-19_runrec_hq_auth.sql) diverged from what is
-- actually running in production. The live DB was hand-edited afterwards:
--   • the enqueue trigger was replaced (now fires on owners + owners_done and
--     pings newly-added owners AND a newly-set active turn, deduped),
--   • the auth.users sync trigger became UPDATE-ONLY (no INSERT fallback —
--     unknown emails can never auto-create a team_member),
--   • RLS policies were tightened to bind via team_members.user_id = auth.uid().
--
-- This file captures the LIVE state verbatim (verified 2026-05-23 via the
-- Supabase Management API) so the migration history is once again a faithful,
-- re-runnable source of truth. It is idempotent and safe to re-run.
--
-- Project: ivdzpptjtwoxdaxsbsqz (HQ).  NEVER apply to the booking project.

------------------------------------------------------------
-- 1) team_members (Slack identity ↔ owner_key map). Already populated in prod;
--    this only ensures the shape. Seed inserts are intentionally omitted here
--    so re-running can't clobber the live bindings.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_members (
  id           bigserial PRIMARY KEY,
  email        text UNIQUE NOT NULL,
  user_id      uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_key    text UNIQUE,
  slack_id     text UNIQUE,
  display_name text,
  role         text NOT NULL DEFAULT 'member',
  created_at   timestamptz NOT NULL DEFAULT now()
);

------------------------------------------------------------
-- 2) auth.users → team_members binding. UPDATE-ONLY by design: it matches an
--    existing pre-authorized row by email and stamps user_id + slack_id. It
--    never INSERTs, so an unknown email can never become a team member even if
--    it somehow obtained a session. Combined with disable_signup=true and the
--    login page's shouldCreateUser:false, the board stays team-only.
------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_team_member_from_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slack_id text := NEW.raw_user_meta_data ->> 'provider_id';
  v_name     text := COALESCE(NEW.raw_user_meta_data ->> 'name',
                              NEW.raw_user_meta_data ->> 'full_name');
BEGIN
  UPDATE public.team_members
     SET user_id      = NEW.id,
         slack_id     = COALESCE(v_slack_id, slack_id),
         display_name = COALESCE(v_name, display_name)
   WHERE email = NEW.email;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_team_member ON auth.users;
CREATE TRIGGER trg_sync_team_member
AFTER INSERT OR UPDATE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.sync_team_member_from_auth();

------------------------------------------------------------
-- 3) RLS: tasks + team_members are reachable ONLY by signed-in team members.
--    Anon (publishable key, no user JWT) gets zero rows — verified 2026-05-23.
------------------------------------------------------------
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks        ENABLE ROW LEVEL SECURITY;

-- Drop any legacy/anon policies from the older migration.
DROP POLICY IF EXISTS "team_members_all_read" ON public.team_members;
DROP POLICY IF EXISTS "tasks_authed_read"     ON public.tasks;
DROP POLICY IF EXISTS "tasks_authed_write"    ON public.tasks;
DROP POLICY IF EXISTS "tasks_authed_update"   ON public.tasks;
DROP POLICY IF EXISTS "tasks_authed_delete"   ON public.tasks;

-- team_members: a member can read only their own row.
DROP POLICY IF EXISTS "team_members_self_read" ON public.team_members;
CREATE POLICY "team_members_self_read" ON public.team_members
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- tasks: full CRUD only for bound team members (membership = a team_members row
-- whose user_id matches the caller's auth.uid()).
DROP POLICY IF EXISTS "tasks_member_read"   ON public.tasks;
DROP POLICY IF EXISTS "tasks_member_insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks_member_update" ON public.tasks;
DROP POLICY IF EXISTS "tasks_member_delete" ON public.tasks;

CREATE POLICY "tasks_member_read" ON public.tasks
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = auth.uid()));
CREATE POLICY "tasks_member_insert" ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = auth.uid()));
CREATE POLICY "tasks_member_update" ON public.tasks
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = auth.uid()));
CREATE POLICY "tasks_member_delete" ON public.tasks
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = auth.uid()));

------------------------------------------------------------
-- 4) Slack notification outbox + enqueue trigger.
--    enqueue_task_notification pings:
--      (a) every NEWLY-ADDED owner (in NEW.owners, not in OLD.owners), and
--      (b) a NEWLY-SET active turn (owners_done[0]) when it changes,
--    deduped so a person added AND made the active turn in one gesture is
--    pinged exactly once. Verified 2026-05-23: a single INSERT with owners=[sal]
--    and owners_done=[sal] produced exactly ONE queue row.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.slack_notification_queue (
  id          bigserial PRIMARY KEY,
  task_slug   text NOT NULL,
  task_title  text NOT NULL,
  owner_key   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  error       text
);
ALTER TABLE public.slack_notification_queue ENABLE ROW LEVEL SECURITY;
-- No client policies: only the service role (Edge Function) touches this table.

CREATE OR REPLACE FUNCTION public.enqueue_task_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k text;
  to_notify text[] := '{}';
  new_o    jsonb := COALESCE(NEW.owners::jsonb, '[]'::jsonb);
  old_o    jsonb := CASE WHEN TG_OP='UPDATE' THEN COALESCE(OLD.owners::jsonb,'[]'::jsonb) ELSE '[]'::jsonb END;
  new_done jsonb := COALESCE(NEW.owners_done::jsonb, '[]'::jsonb);
  old_done jsonb := CASE WHEN TG_OP='UPDATE' THEN COALESCE(OLD.owners_done::jsonb,'[]'::jsonb) ELSE '[]'::jsonb END;
  na text := CASE WHEN jsonb_array_length(new_done)>0 THEN new_done->>0 END;
  oa text := CASE WHEN jsonb_array_length(old_done)>0 THEN old_done->>0 END;
BEGIN
  FOR k IN SELECT jsonb_array_elements_text(new_o) LOOP
    IF NOT (old_o ? k) THEN to_notify := array_append(to_notify, k); END IF;
  END LOOP;
  IF na IS NOT NULL AND na IS DISTINCT FROM oa AND NOT (na = ANY(to_notify)) THEN
    to_notify := array_append(to_notify, na);
  END IF;
  FOREACH k IN ARRAY to_notify LOOP
    INSERT INTO public.slack_notification_queue (task_slug, task_title, owner_key)
    VALUES (NEW.slug, NEW.title, k);
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_task_notification ON public.tasks;
DROP TRIGGER IF EXISTS trg_enqueue_turn_notification ON public.tasks;  -- legacy name
CREATE TRIGGER trg_enqueue_task_notification
AFTER INSERT OR UPDATE OF owners, owners_done ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enqueue_task_notification();

-- Legacy, now-unused function from the 2026-05-19 migration. Dropped 2026-05-23.
DROP FUNCTION IF EXISTS public.enqueue_turn_notification() CASCADE;

------------------------------------------------------------
-- 5) Queue → Edge fan-out. On INSERT into the outbox, fire the edge function
--    via pg_net. Uses the PUBLISHABLE key only (no service_role in the DB).
------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_slack_queue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://ivdzpptjtwoxdaxsbsqz.supabase.co/functions/v1/slack-turn-notify',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey','sb_publishable_CLEzGz8hR3Z2cioPFSSu-g_33VtSdDb',
      'Authorization','Bearer sb_publishable_CLEzGz8hR3Z2cioPFSSu-g_33VtSdDb'
    ),
    body := jsonb_build_object('queued_id', NEW.id)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_slack_queue ON public.slack_notification_queue;
CREATE TRIGGER trg_notify_slack_queue
AFTER INSERT ON public.slack_notification_queue
FOR EACH ROW EXECUTE FUNCTION public.notify_slack_queue();
