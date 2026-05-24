-- ─────────────────────────────────────────────────────────────────────────
-- runrec#15.2 — Allow the task page to send a manual "nudge"
--
-- slack_notification_queue has RLS enabled with zero policies, so the client
-- cannot write to it (only the server-side trigger can). The ping button needs
-- a signed-in team member to insert a row. This policy is deliberately narrow:
--   • role authenticated only
--   • kind MUST be 'nudge' (client can't spoof 'turn'/'due')
--   • the inserter must be a bound team member
-- No SELECT/UPDATE/DELETE is granted; 'turn' rows (trigger) and 'due' rows
-- (cron) are inserted server-side and bypass RLS as before.
-- ─────────────────────────────────────────────────────────────────────────

drop policy if exists "queue_member_insert_nudge" on public.slack_notification_queue;
create policy "queue_member_insert_nudge" on public.slack_notification_queue
  for insert to authenticated
  with check (
    kind = 'nudge'
    and exists (select 1 from public.team_members tm where tm.user_id = auth.uid())
  );
