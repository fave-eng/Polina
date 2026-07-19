-- Secure Telegram notifications for Polina's English Space.
-- Run once in Supabase Dashboard -> SQL Editor in the POLINA project.

create extension if not exists pgcrypto;

create table if not exists public.telegram_recipients (
  id uuid primary key default gen_random_uuid(),
  student_id text not null unique,
  chat_id bigint not null unique,
  message_thread_id bigint,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.telegram_recipients
  add column if not exists message_thread_id bigint;

create table if not exists public.material_publications (
  id uuid primary key default gen_random_uuid(),
  student_id text not null,
  material_type text not null,
  material_id text not null,
  notification_version integer not null default 1 check (notification_version > 0),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped')),
  payload jsonb not null default '{}'::jsonb,
  telegram_message_id bigint,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, material_type, material_id, notification_version)
);

create index if not exists material_publications_student_idx
  on public.material_publications (student_id, created_at desc);

create or replace function public.set_telegram_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists telegram_recipients_set_updated_at on public.telegram_recipients;
create trigger telegram_recipients_set_updated_at
before update on public.telegram_recipients
for each row execute function public.set_telegram_updated_at();

drop trigger if exists material_publications_set_updated_at on public.material_publications;
create trigger material_publications_set_updated_at
before update on public.material_publications
for each row execute function public.set_telegram_updated_at();

-- These tables are server-only. The public website cannot read chat IDs or logs.
alter table public.telegram_recipients enable row level security;
alter table public.material_publications enable row level security;

revoke all on table public.telegram_recipients from anon, authenticated;
revoke all on table public.material_publications from anon, authenticated;

grant all on table public.telegram_recipients to service_role;
grant all on table public.material_publications to service_role;

-- Existing Polina Telegram group from the old site.
-- message_thread_id is NULL, so the message goes to the default/general topic.
insert into public.telegram_recipients (student_id, chat_id, message_thread_id, enabled)
values ('polina', -1003908460669, null, true)
on conflict (student_id) do update
set chat_id = excluded.chat_id,
    message_thread_id = excluded.message_thread_id,
    enabled = true,
    updated_at = now();
