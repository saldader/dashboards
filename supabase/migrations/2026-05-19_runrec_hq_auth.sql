-- RunRec HQ — Auth migration (v2, fixed)
-- Idempotent and order-of-operations safe.

------------------------------------------------------------
-- 1) Clean slate for the RunRec HQ objects (only ours).
------------------------------------------------------------
DROP TRIGGER  IF EXISTS trg_enqueue_turn_notification    ON public.tasks;
DROP TRIGGER  IF EXISTS trg_sync_team_member             ON auth.users;
DROP FUNCTION IF EXISTS public.enqueue_turn_notification CASCADE;
DROP FUNCTION IF EXISTS public.sync_team_member_from_auth CASCADE;
DROP TABLE    IF EXISTS public.slack_notification_queue  CASCADE;
DROP TABLE    IF EXISTS public.team_members              CASCADE;

------------------------------------------------------------
-- 2) team_members: maps Slack identities to owner keys.
--    Email is the natural key. user_id is filled on first Slack sign-in.
------------------------------------------------------------
CREATE TABLE public.team_members (
  id           bigserial PRIMARY KEY,
  email        text UNIQUE NOT NULL,
  user_id      uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_key    text UNIQUE,
  slack_id     text UNIQUE,
  display_name text,
  role         text NOT NULL DEFAULT 'member',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Seed the team. Update these emails to match the Slack accounts each
-- person signs in with. The trigger below binds them on first sign-in.
INSERT INTO public.team_members (email, owner_key, display_name, role) VALUES
  ('sal@therunrec.com',    'sal',    'Sal Dader',     'admin'),
  ('izzy@therunrec.com',   'izzy',   'Izzy Yusuf',    'admin'),
  ('eyad@therunrec.com',   'eyad',   'Eyad Attia',    'member'),
  ('brian@therunrec.com',  'brian',  'Brian Bazely',  'admin'),
  ('rammah@therunrec.com', 'rammah', 'Rammah',        'member'),
  ('rob@therunrec.com',    'rob',    'Rob Salloum',   'member');

------------------------------------------------------------
-- 3) Trigger on auth.users — bind Slack sign-ins to team_members by email.
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

  IF NOT FOUND THEN
    INSERT INTO public.team_members (email, user_id, slack_id, display_name, role)
    VALUES (NEW.email, NEW.id, v_slack_id, v_name, 'member')
    ON CONFLICT (email) DO UPDATE SET
      user_id      = EXCLUDED.user_id,
      slack_id     = COALESCE(EXCLUDED.slack_id, public.team_members.slack_id),
      display_name = COALESCE(EXCLUDED.display_name, public.team_members.display_name);
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_team_member
AFTER INSERT OR UPDATE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.sync_team_member_from_auth();

------------------------------------------------------------
-- 4) RLS: tasks readable/writable only by signed-in users.
------------------------------------------------------------
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_members_all_read" ON public.team_members;
CREATE POLICY "team_members_all_read" ON public.team_members
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "tasks_authed_read"   ON public.tasks;
DROP POLICY IF EXISTS "tasks_authed_write"  ON public.tasks;
DROP POLICY IF EXISTS "tasks_authed_update" ON public.tasks;
DROP POLICY IF EXISTS "tasks_authed_delete" ON public.tasks;

CREATE POLICY "tasks_authed_read"   ON public.tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY "tasks_authed_write"  ON public.tasks FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "tasks_authed_update" ON public.tasks FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "tasks_authed_delete" ON public.tasks FOR DELETE TO authenticated USING (true);

------------------------------------------------------------
-- 5) Slack notification outbox + trigger.
------------------------------------------------------------
CREATE TABLE public.slack_notification_queue (
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

CREATE OR REPLACE FUNCTION public.enqueue_turn_notification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  new_arr jsonb := COALESCE(NEW.owners_done::jsonb, '[]'::jsonb);
  old_arr jsonb := CASE WHEN TG_OP = 'UPDATE'
                        THEN COALESCE(OLD.owners_done::jsonb, '[]'::jsonb)
                        ELSE '[]'::jsonb END;
  new_active text := CASE WHEN jsonb_array_length(new_arr) > 0 THEN new_arr ->> 0 END;
  old_active text := CASE WHEN jsonb_array_length(old_arr) > 0 THEN old_arr ->> 0 END;
BEGIN
  IF new_active IS NOT NULL AND new_active IS DISTINCT FROM old_active THEN
    INSERT INTO public.slack_notification_queue (task_slug, task_title, owner_key)
    VALUES (NEW.slug, NEW.title, new_active);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enqueue_turn_notification
AFTER INSERT OR UPDATE OF owners_done ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enqueue_turn_notification();
