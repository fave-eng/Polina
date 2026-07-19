-- OPTIONAL: run only after the new site has been tested successfully.
-- The old public.progress table and its backup remain in the database,
-- but the public browser key can no longer read or modify them.

begin;
alter table public.progress enable row level security;
revoke all on table public.progress from anon, authenticated;
revoke all on table public.progress_legacy_backup from anon, authenticated;
revoke all on table public.legacy_progress_snapshots from anon, authenticated;
commit;
