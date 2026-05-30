-- Fix: the content board form sends null for empty optional fields, but these
-- columns were created NOT NULL, so every edit with a blank field was rejected.
-- Allow them to be empty (null). The board renders empty/null gracefully.

alter table public.content_pieces alter column synopsis    drop not null;
alter table public.content_pieces alter column hook         drop not null;
alter table public.content_pieces alter column cta          drop not null;
alter table public.content_pieces alter column performance  drop not null;
alter table public.content_pieces alter column notes        drop not null;
