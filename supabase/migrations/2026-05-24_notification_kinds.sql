-- ─────────────────────────────────────────────────────────────────────────
-- runrec#15.1 — Notification "kinds" foundation
--
-- The Slack notification pipeline previously sent a single message ("your turn").
-- These columns let the same queue carry different message types so we can add
-- a manual nudge ("where are we at?") and due-today reminders without forking
-- the pipeline.
--
--   kind  : message template the edge fn renders. 'turn' (default, = existing
--           behavior), 'nudge', 'due'. Unknown values fall through to 'turn'.
--   actor : optional display name of whoever triggered it (used by 'nudge',
--           e.g. "Sal is checking in"). NULL for system/auto pings.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.slack_notification_queue
  add column if not exists kind  text not null default 'turn',
  add column if not exists actor text;
