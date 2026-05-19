-- RunRec HQ — Auth migration
-- Paste this whole file into Supabase SQL editor and Run.
-- Idempotent: safe to run multiple times.

------------------------------------------------------------
-- 1) team_members table: maps Slack identities to owner keys
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.team_members (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text UNIQUE,
  owner_key   text UNIQUE,            -- 'sal', 'izzy', 'eyad', 'brian', 'rammah', 'rob', ...
  slack_id    text UNIQUE,            -- 'U01...' Slack user id, populated on first login
  display_name text,
  role        text NOT NULL DEFAULT 'member',  -- 'admin' or 'member'
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed the team. owner_key matches the OWNER_KEYS in the kanban JS.
-- Update emails to match the Slack accounts each person signs in with.
INSERT INTO public.team_members (user_id, email, owner_key, display_name, role)
VALUES
  (gen_random_uuid(), 'sal@therunrec.com',    'sal',    'Sal Dader',     'admin'),
  (gen_random_uuid(), 'izzy@therunrec.com',   'izzy',   'Izzy Yusuf',    'admin'),
  (gen_random_uuid(), 'eyad@therunrec.com',   'eyad',   'Eyad Attia',    'member'),
  (gen_random_uuid(), 'brian@therunrec.com',  'brian',  'Brian Bazely',  'admin'),
  (gen_random_uuid(), 'rammah@therunrec.com', 'rammah', 'Rammah',        'member'),
  (gen_random_uuid(), 'rob@therunrec.com',    'rob',    'Rob Salloum',   'member')
ON CONFLICT (email) DO NOTHING;

------------------------------------------------------------
-- 2) Trigger: on auth.users insert/update, sync to team_members
--    matches by email so Slack login binds to the right owner_key.
------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sync_team_member_from_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slack_id text;
BEGIN
  v_slack_id := NEW.raw_user_meta_data ->> 'provider_id';

  UPDATE public.team_members
     SET user_id      = NEW.id,
         slack_id     = COALESCE(v_slack_id, slack_id),
         display_name = COALESCE(
                          NEW.raw_user_meta_data ->> 'name',
                          NEW.raw_user_meta_data ->> 'full_name',
                          display_name
                        )
   WHERE email = NEW.email;

  -- If no matching team_members row, create a basic one (no owner_key, member role).
  IF NOT FOUND THEN
    INSERT INTO public.team_members (user_id, email, slack_id, display_name, role)
    VALUES (
      NEW.id,
      NEW.email,
      v_slack_id,
      COALESCE(NEW.raw_user_meta_data ->> 'name', NEW.raw_user_meta_data ->> 'full_name'),
      'member'
    )
    ON CONFLICT (email) DO UPDATE SET
      user_id      = EXCLUDED.user_id,
      slack_id     = COALESCE(EXCLUDED.slack_id, public.team_members.slack_id),
      display_name = COALESCE(EXCLUDED.display_name, public.team_members.display_name);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_team_member ON auth.users;
CREATE TRIGGER trg_sync_team_member
AFTER INSERT OR UPDATE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.sync_team_member_from_auth();

------------------------------------------------------------
-- 3) Row-Level Security
------------------------------------------------------------

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks        ENABLE ROW LEVEL SECURITY;

-- Drop any previously created policies under the same names so this is idempotent.
DROP POLICY IF EXISTS "team_members_self_read"   ON public.team_members;
DROP POLICY IF EXISTS "team_members_all_read"    ON public.team_members;
DROP POLICY IF EXISTS "tasks_authed_read"        ON public.tasks;
DROP POLICY IF EXISTS "tasks_authed_write"       ON public.tasks;
DROP POLICY IF EXISTS "tasks_authed_update"      ON public.tasks;
DROP POLICY IF EXISTS "tasks_authed_delete"      ON public.tasks;

-- Any signed-in team member can see all team members (lookups for chips, mentions).
CREATE POLICY "team_members_all_read" ON public.team_members
  FOR SELECT TO authenticated USING (true);

-- Any signed-in user can read/write tasks. We trust the workspace, the auth gate is the perimeter.
CREATE POLICY "tasks_authed_read"   ON public.tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY "tasks_authed_write"  ON public.tasks FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "tasks_authed_update" ON public.tasks FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "tasks_authed_delete" ON public.tasks FOR DELETE TO authenticated USING (true);

------------------------------------------------------------
-- 4) Slack notification scaffolding: a tiny outbox table the
--    Edge Function reads when 'owners_done' changes.
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
-- No client policies. Only the service role (Edge Function) reads/writes this.

CREATE OR REPLACE FUNCTION public.enqueue_turn_notification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  new_active text;
  old_active text;
BEGIN
  new_active := CASE WHEN jsonb_array_length(COALESCE(NEW.owners_done::jsonb, '[]'::jsonb)) > 0
                     THEN NEW.owners_done::jsonb ->> 0 END;
  old_active := CASE WHEN TG_OP = 'UPDATE' AND jsonb_array_length(COALESCE(OLD.owners_done::jsonb, '[]'::jsonb)) > 0
                     THEN OLD.owners_done::jsonb ->> 0 END;

  IF new_active IS NOT NULL AND new_active IS DISTINCT FROM old_active THEN
    INSERT INTO public.slack_notification_queue (task_slug, task_title, owner_key)
    VALUES (NEW.slug, NEW.title, new_active);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_turn_notification ON public.tasks;
CREATE TRIGGER trg_enqueue_turn_notification
AFTER INSERT OR UPDATE OF owners_done ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enqueue_turn_notification();
