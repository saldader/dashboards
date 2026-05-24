-- Task archive support
-- ---------------------------------------------------------------------------
-- Lets Done tasks be filed away (hidden from the board) without being deleted,
-- and restored ("unarchived") later.
--
-- Why a boolean column instead of a new status value:
--   tasks.status has a CHECK constraint (tasks_status_check) limited to
--   'not-started','in-progress','blocked','done'. A separate boolean is purely
--   additive — every existing row defaults to false — so it needs no constraint
--   change and keeps status semantically correct ('done' stays 'done').
--
-- Safe to run more than once (idempotent guards).

alter table public.tasks
  add column if not exists archived boolean not null default false;

-- The board always filters active vs archived, so index the flag.
create index if not exists tasks_archived_idx on public.tasks (archived);
