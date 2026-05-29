-- RunRec Content tracker table (RunRec x PGC social pipeline)
-- Mirrors the tasks table pattern: uuid id, position ordering, archived flag,
-- and RLS granting full access to authenticated team_members.

create table if not exists public.content_pieces (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  vertical        text not null default '',          -- Franchise ownership | Basketball culture | RunRec lifestyle
  format          text not null default '',          -- Reel | Carousel | Text | Story
  channel         text not null default '',          -- comma separated: IG, TikTok, LinkedIn, X
  owner           text not null default '',          -- RunRec | Izzy | Sal | Mano | PGC
  status          text not null default 'Idea',      -- Idea | Scripting | Shooting | Editing | Approval | Scheduled | Posted
  reshare_status  text not null default 'N/A',       -- N/A | Asked | Reshared | Declined
  post_date       date,
  performance     text not null default '',
  notes           text not null default '',
  position        double precision default 1000,
  archived        boolean not null default false,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table public.content_pieces enable row level security;

create policy content_member_read   on public.content_pieces for select to authenticated
  using (exists (select 1 from team_members tm where tm.user_id = auth.uid()));
create policy content_member_insert on public.content_pieces for insert to authenticated
  with check (exists (select 1 from team_members tm where tm.user_id = auth.uid()));
create policy content_member_update on public.content_pieces for update to authenticated
  using (exists (select 1 from team_members tm where tm.user_id = auth.uid()))
  with check (exists (select 1 from team_members tm where tm.user_id = auth.uid()));
create policy content_member_delete on public.content_pieces for delete to authenticated
  using (exists (select 1 from team_members tm where tm.user_id = auth.uid()));
