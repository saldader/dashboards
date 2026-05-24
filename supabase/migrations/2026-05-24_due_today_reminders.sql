-- ─────────────────────────────────────────────────────────────────────────
-- runrec#15.3 — Due-today daily auto-reminder
--
-- Every morning at 08:00 America/Toronto, ping the owner(s) of any task whose
-- due_date is today and which isn't done. Reuses the 'due' message kind from
-- Part 1 ("⏰ Due today — {task}"). Self-contained in Postgres via pg_cron —
-- runs even if no other machine is on.
--
-- Design:
--   • core fn `enqueue_due_today_reminders()` is GUARD-FREE (enqueues for
--     "today" whenever called) so it can be tested directly.
--   • the cron job runs HOURLY and applies the 08:00-Toronto guard in the
--     scheduled command — DST-proof (pg_cron schedules are UTC-only, so a
--     fixed UTC time would drift an hour across DST).
--   • idempotent: a NOT EXISTS check means a task pings its owner at most once
--     per day even if the job (or a manual call) runs more than once.
-- ─────────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;

create or replace function public.enqueue_due_today_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_today date := (now() at time zone 'America/Toronto')::date;
  v_count integer;
begin
  with ins as (
    insert into public.slack_notification_queue (task_slug, task_title, owner_key, kind, actor)
    select t.slug, t.title, ok.owner_key, 'due', null
    from public.tasks t
    cross join lateral jsonb_array_elements_text(coalesce(t.owners, '[]'::jsonb)) as ok(owner_key)
    where t.due_date = v_today
      and t.status <> 'done'
      and not exists (
        select 1 from public.slack_notification_queue q
        where q.kind = 'due'
          and q.task_slug = t.slug
          and q.owner_key = ok.owner_key
          and (q.created_at at time zone 'America/Toronto')::date = v_today
      )
    returning 1
  )
  select count(*) into v_count from ins;
  return v_count;
end;
$fn$;

-- (Re)schedule the hourly job with the 08:00-Toronto guard.
do $resched$
begin
  if exists (select 1 from cron.job where jobname = 'due-today-reminders') then
    perform cron.unschedule('due-today-reminders');
  end if;
end
$resched$;

select cron.schedule(
  'due-today-reminders',
  '0 * * * *',
  $cmd$
  do $guard$
  begin
    if to_char(now() at time zone 'America/Toronto', 'HH24') = '08' then
      perform public.enqueue_due_today_reminders();
    end if;
  end
  $guard$;
  $cmd$
);
