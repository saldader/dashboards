-- ─────────────────────────────────────────────────────────────────────────
-- 2026-05-31 — Notification pipeline reliability
--
-- Closes the holes that let a "nudge" silently vanish (verified root cause:
-- the browser INSERT into slack_notification_queue was rejected when the
-- caller's JWT was stale, and failures were marked "sent" with no retry).
--
-- This migration adds:
--   1. attempts column  — separate "tried" from "succeeded"
--   2. enqueue_nudge()   — SECURITY DEFINER RPC so nudge creation can never be
--                          blocked by client-side RLS edge cases again
--   3. dead-letter view  — surfaces rows that exhausted retries
--   4. cron drain        — a backup to the webhook so delivery never depends on
--                          a single path
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Separate "attempted" from "succeeded". sent_at is ONLY set on real success.
alter table public.slack_notification_queue
  add column if not exists attempts int not null default 0;

-- 2. Server-side nudge enqueue. Runs as definer, so a valid signed-in member
--    can always enqueue regardless of table RLS. Validates the caller is a
--    bound team member and only enqueues for real owner_keys.
create or replace function public.enqueue_nudge(
  p_task_slug  text,
  p_task_title text,
  p_owner_keys text[],
  p_actor      text
) returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count int := 0;
  v_key   text;
begin
  if not exists (select 1 from public.team_members tm where tm.user_id = auth.uid()) then
    raise exception 'not authorized: caller is not a bound team member';
  end if;

  if p_owner_keys is null or array_length(p_owner_keys, 1) is null then
    return 0;
  end if;

  foreach v_key in array p_owner_keys loop
    if exists (select 1 from public.team_members tm where tm.owner_key = v_key) then
      insert into public.slack_notification_queue (task_slug, task_title, owner_key, kind, actor)
      values (p_task_slug, p_task_title, v_key, 'nudge', p_actor);
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$fn$;

revoke all on function public.enqueue_nudge(text, text, text[], text) from public;
grant execute on function public.enqueue_nudge(text, text, text[], text) to authenticated;

-- 3. Dead-letter view: rows that failed repeatedly and were never delivered.
create or replace view public.slack_notification_deadletter as
  select id, task_slug, task_title, owner_key, kind, actor, attempts, error, created_at
  from public.slack_notification_queue
  where sent_at is null and attempts >= 5;

-- 4. Cron drain — backup to the DB webhook. Fires every minute, but only makes
--    an HTTP call when there is genuinely pending work, so it is cheap. The
--    edge function itself drains up to 25 pending rows per invocation.
do $unschedule$
begin
  perform cron.unschedule('drain-slack-queue');
exception when others then
  null;  -- job did not exist yet
end
$unschedule$;

select cron.schedule('drain-slack-queue', '* * * * *', $cron$
  do $drain$
  begin
    if exists (
      select 1 from public.slack_notification_queue
      where sent_at is null and attempts < 5
    ) then
      perform net.http_post(
        url     := 'https://ivdzpptjtwoxdaxsbsqz.supabase.co/functions/v1/slack-turn-notify',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', 'sb_publishable_CLEzGz8hR3Z2cioPFSSu-g_33VtSdDb',
          'Authorization', 'Bearer sb_publishable_CLEzGz8hR3Z2cioPFSSu-g_33VtSdDb'
        ),
        body := jsonb_build_object('source', 'cron-drain')
      );
    end if;
  end
  $drain$;
$cron$);
