-- ─────────────────────────────────────────────────────────────────────────
-- runrec#13.5 — Fix image upload (storage backend)
--
-- Root cause (audited 2026-05-24): the `task-attachments` bucket referenced by
-- task/index.html never existed in prod, AND the client sent the publishable
-- (anon) key as the Bearer token. After the 2026-05-23 cutover (anon dropped,
-- RLS bound to team_members), uploads had no valid identity and no bucket.
--
-- This migration creates the bucket (public read, matching the /object/public/
-- URLs the client constructs) and adds storage.objects RLS policies so only
-- signed-in team members can write. The client fix (send user JWT) is in
-- task/index.html uploadImage().
-- ─────────────────────────────────────────────────────────────────────────

-- 1) Bucket: public read so inline <img> URLs render on the locked board.
insert into storage.buckets (id, name, public)
values ('task-attachments', 'task-attachments', true)
on conflict (id) do update set public = true;

-- 2) RLS policies on storage.objects, scoped to this bucket.

-- Public read: matches the client's /object/public/ URLs (unguessable filenames).
drop policy if exists "task_attach_public_read" on storage.objects;
create policy "task_attach_public_read" on storage.objects
  for select to public
  using (bucket_id = 'task-attachments');

-- Insert: only signed-in team members (membership = a team_members row).
drop policy if exists "task_attach_member_insert" on storage.objects;
create policy "task_attach_member_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'task-attachments'
    and exists (select 1 from public.team_members tm where tm.user_id = auth.uid())
  );

-- Update: supports the client's x-upsert:true; same membership gate.
drop policy if exists "task_attach_member_update" on storage.objects;
create policy "task_attach_member_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'task-attachments'
    and exists (select 1 from public.team_members tm where tm.user_id = auth.uid())
  )
  with check (
    bucket_id = 'task-attachments'
    and exists (select 1 from public.team_members tm where tm.user_id = auth.uid())
  );
