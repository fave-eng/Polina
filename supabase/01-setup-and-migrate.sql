-- English Space · Polina
-- 1) Creates the new progress tables used by the Kristina-style site.
-- 2) Keeps the old public.progress table intact.
-- 3) Makes a full backup/snapshot of the legacy row.
-- 4) Migrates homework, grammar and aggregate vocabulary progress.
--
-- Run this ONCE in Polina's Supabase project:
-- Dashboard -> SQL Editor -> New query -> paste this file -> Run.

begin;

create extension if not exists pgcrypto;

-- Exact, one-time physical copy of the old table. Nothing is deleted.
do $$
begin
  if to_regclass('public.progress_legacy_backup') is null then
    execute 'create table public.progress_legacy_backup as table public.progress';
  end if;
end $$;

-- A JSON snapshot is convenient for later inspection and contains every old field,
-- including published_homeworks and homework_notifications.
create table if not exists public.legacy_progress_snapshots (
  student_id text primary key,
  payload jsonb not null,
  source_updated_at timestamptz,
  snapshot_at timestamptz not null default now()
);

insert into public.legacy_progress_snapshots (student_id, payload, source_updated_at, snapshot_at)
select p.student, to_jsonb(p), p.updated_at, now()
from public.progress p
where p.student = 'polina'
on conflict (student_id) do update
set payload = excluded.payload,
    source_updated_at = excluded.source_updated_at,
    snapshot_at = excluded.snapshot_at;

create table if not exists public.homework_progress (
  student_id text not null,
  lesson_id text not null,
  student_name text,
  lesson_title text,
  status text not null default 'checked'
    check (status in ('checked', 'submitted')),
  answers jsonb not null default '{}'::jsonb,
  legacy_answers jsonb,
  migrated_from_legacy boolean not null default false,
  score_correct integer,
  score_total integer,
  score_percent integer,
  checked_at timestamptz,
  submitted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (student_id, lesson_id)
);

create table if not exists public.vocabulary_progress (
  student_id text not null,
  word_key text not null,
  word_id text,
  en text,
  ru text,
  source_topic_id text,
  status text not null check (status in ('known', 'difficult')),
  learned_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (student_id, word_key)
);

create table if not exists public.vocabulary_topic_progress (
  student_id text not null,
  topic_id text not null,
  tests jsonb not null default '[]'::jsonb,
  legacy_learned_count integer not null default 0,
  legacy_total integer not null default 0,
  legacy_source text,
  legacy_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (student_id, topic_id)
);

create table if not exists public.grammar_progress (
  student_id text not null,
  topic_id text not null,
  passed boolean not null default false,
  attempts integer not null default 0,
  best_score integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (student_id, topic_id)
);

-- Add missing columns safely if an earlier draft of the schema was already run.
alter table public.homework_progress add column if not exists legacy_answers jsonb;
alter table public.homework_progress add column if not exists migrated_from_legacy boolean not null default false;
alter table public.vocabulary_progress add column if not exists word_id text;
alter table public.vocabulary_progress add column if not exists en text;
alter table public.vocabulary_progress add column if not exists ru text;
alter table public.vocabulary_progress add column if not exists source_topic_id text;
alter table public.vocabulary_topic_progress add column if not exists legacy_learned_count integer not null default 0;
alter table public.vocabulary_topic_progress add column if not exists legacy_total integer not null default 0;
alter table public.vocabulary_topic_progress add column if not exists legacy_source text;
alter table public.vocabulary_topic_progress add column if not exists legacy_updated_at timestamptz;
alter table public.homework_progress alter column score_correct drop not null;
alter table public.homework_progress alter column score_total drop not null;
alter table public.homework_progress alter column score_percent drop not null;

create or replace function public.set_english_space_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists homework_progress_set_updated_at on public.homework_progress;
create trigger homework_progress_set_updated_at
before update on public.homework_progress
for each row execute function public.set_english_space_updated_at();

drop trigger if exists vocabulary_progress_set_updated_at on public.vocabulary_progress;
create trigger vocabulary_progress_set_updated_at
before update on public.vocabulary_progress
for each row execute function public.set_english_space_updated_at();

drop trigger if exists vocabulary_topic_progress_set_updated_at on public.vocabulary_topic_progress;
create trigger vocabulary_topic_progress_set_updated_at
before update on public.vocabulary_topic_progress
for each row execute function public.set_english_space_updated_at();

drop trigger if exists grammar_progress_set_updated_at on public.grammar_progress;
create trigger grammar_progress_set_updated_at
before update on public.grammar_progress
for each row execute function public.set_english_space_updated_at();

-- Homework 4–8: score, completion status and the complete legacy answer JSON.
with legacy as (
  select * from public.progress where student = 'polina' limit 1
), source_rows as (
  select
    'polina'::text as student_id,
    'Полина'::text as student_name,
    v.lesson_id,
    v.lesson_title,
    v.score_text,
    v.legacy_answers,
    legacy.updated_at
  from legacy
  cross join lateral (
    values
      ('lesson-4', 'Everyday Minor Problems',
        coalesce(legacy.hw_scores ->> '4', legacy.hw4_score), legacy.hw_answers -> '4'),
      ('lesson-5', 'Talking My Language',
        coalesce(legacy.hw_scores ->> '5', legacy.hw5_score), legacy.hw_answers -> '5'),
      ('lesson-6', 'Putting Your Words to Work',
        coalesce(legacy.hw_scores ->> '6', legacy.hw6_score), legacy.hw_answers -> '6'),
      ('lesson-7', 'Feelings & Emotions',
        coalesce(legacy.hw_scores ->> '7', legacy.hw_scores ->> 'feelings_u2'),
        coalesce(legacy.hw_answers -> '7', legacy.hw_answers -> 'feelings_u2')),
      ('lesson-8', 'Linking Verbs, Responses & Listening',
        legacy.hw_scores ->> '8', legacy.hw_answers -> '8')
  ) as v(lesson_id, lesson_title, score_text, legacy_answers)
), parsed as (
  select *, regexp_replace(score_text, '[[:space:]]', '', 'g') as compact_score
  from source_rows
  where score_text is not null
    and score_text ~ '^[[:space:]]*[0-9]+[[:space:]]*/[[:space:]]*[0-9]+[[:space:]]*$'
)
insert into public.homework_progress (
  student_id, lesson_id, student_name, lesson_title, status,
  answers, legacy_answers, migrated_from_legacy,
  score_correct, score_total, score_percent,
  checked_at, submitted_at, updated_at
)
select
  student_id,
  lesson_id,
  student_name,
  lesson_title,
  'submitted',
  '{}'::jsonb,
  coalesce(legacy_answers, '{}'::jsonb),
  true,
  split_part(compact_score, '/', 1)::integer,
  split_part(compact_score, '/', 2)::integer,
  case
    when split_part(compact_score, '/', 2)::integer > 0
      then round(
        split_part(compact_score, '/', 1)::numeric
        / split_part(compact_score, '/', 2)::numeric * 100
      )::integer
    else 0
  end,
  updated_at,
  updated_at,
  coalesce(updated_at, now())
from parsed
on conflict (student_id, lesson_id) do update
set legacy_answers = coalesce(public.homework_progress.legacy_answers, excluded.legacy_answers),
    migrated_from_legacy = true,
    score_correct = coalesce(public.homework_progress.score_correct, excluded.score_correct),
    score_total = coalesce(public.homework_progress.score_total, excluded.score_total),
    score_percent = coalesce(public.homework_progress.score_percent, excluded.score_percent),
    checked_at = coalesce(public.homework_progress.checked_at, excluded.checked_at),
    submitted_at = coalesce(public.homework_progress.submitted_at, excluded.submitted_at),
    status = case
      when public.homework_progress.status = 'submitted' then public.homework_progress.status
      else excluded.status
    end;

-- Grammar topics. The old site stored passed/attempts in progress.grammar_progress.
with legacy as (
  select * from public.progress where student = 'polina' limit 1
), entries as (
  select e.key as topic_id, e.value as state, legacy.updated_at
  from legacy
  cross join lateral jsonb_each(coalesce(legacy.grammar_progress, '{}'::jsonb)) e
  where e.key in ('a1-1-basics', 'a1-2-articles', 'a1-3-pronouns')
    and jsonb_typeof(e.value) = 'object'
)
insert into public.grammar_progress (
  student_id, topic_id, passed, attempts, best_score, updated_at
)
select
  'polina',
  topic_id,
  lower(coalesce(state ->> 'passed', 'false')) in ('true', 't', '1', 'yes'),
  case when coalesce(state ->> 'attempts', '') ~ '^[0-9]+$'
    then (state ->> 'attempts')::integer else 0 end,
  case
    when coalesce(state ->> 'bestScore', state ->> 'best_score', '') ~ '^[0-9]+$'
      then coalesce(state ->> 'bestScore', state ->> 'best_score')::integer
    when lower(coalesce(state ->> 'passed', 'false')) in ('true', 't', '1', 'yes') then 100
    else 0
  end,
  coalesce(updated_at, now())
from entries
on conflict (student_id, topic_id) do update
set passed = public.grammar_progress.passed or excluded.passed,
    attempts = greatest(public.grammar_progress.attempts, excluded.attempts),
    best_score = greatest(public.grammar_progress.best_score, excluded.best_score);

-- The old vocabulary tables stored counts, not the identities of individual words.
-- Counts are preserved as a legacy baseline. Exact word states are additionally
-- imported by app.js from the old localStorage when the site stays on the same domain/browser.
with legacy as (
  select * from public.progress where student = 'polina' limit 1
), topic_counts as (
  select x.topic_id, x.learned_count, x.total_count, x.source_name, legacy.updated_at
  from legacy
  cross join lateral (
    values
      ('vocab-lesson-4'::text, legacy.words_learned, 30, 'legacy:words_learned'::text),
      ('vocab-lesson-5', legacy.languages_learned, 36, 'legacy:languages_learned'),
      ('vocab-lesson-6', legacy.language_classes_learned, 20, 'legacy:language_classes_learned'),
      (
        'vocab-lesson-7',
        case
          when coalesce(legacy.grammar_progress -> 'vocab_feelings' ->> 'learned', '') ~ '^[0-9]+$'
            then (legacy.grammar_progress -> 'vocab_feelings' ->> 'learned')::integer
          else 0
        end,
        case
          when coalesce(legacy.grammar_progress -> 'vocab_feelings' ->> 'total', '') ~ '^[0-9]+$'
            then (legacy.grammar_progress -> 'vocab_feelings' ->> 'total')::integer
          else 46
        end,
        'legacy:grammar_progress.vocab_feelings'
      ),
      ('vocab-irregular-verbs', legacy.verbs_learned, 49, 'legacy:verbs_learned')
  ) as x(topic_id, learned_count, total_count, source_name)
)
insert into public.vocabulary_topic_progress (
  student_id, topic_id, tests,
  legacy_learned_count, legacy_total, legacy_source, legacy_updated_at, updated_at
)
select
  'polina',
  topic_id,
  '[]'::jsonb,
  greatest(0, coalesce(learned_count, 0)),
  greatest(0, coalesce(total_count, 0)),
  source_name,
  updated_at,
  coalesce(updated_at, now())
from topic_counts
where coalesce(learned_count, 0) > 0
on conflict (student_id, topic_id) do update
set legacy_learned_count = greatest(
      public.vocabulary_topic_progress.legacy_learned_count,
      excluded.legacy_learned_count
    ),
    legacy_total = greatest(
      public.vocabulary_topic_progress.legacy_total,
      excluded.legacy_total
    ),
    legacy_source = coalesce(
      public.vocabulary_topic_progress.legacy_source,
      excluded.legacy_source
    ),
    legacy_updated_at = greatest(
      public.vocabulary_topic_progress.legacy_updated_at,
      excluded.legacy_updated_at
    );

-- Browser access for the new static site.
alter table public.homework_progress enable row level security;
alter table public.vocabulary_progress enable row level security;
alter table public.vocabulary_topic_progress enable row level security;
alter table public.grammar_progress enable row level security;

revoke all on table public.legacy_progress_snapshots from anon, authenticated;
revoke all on table public.progress_legacy_backup from anon, authenticated;

grant select, insert, update on table public.homework_progress to anon;
grant select, insert, update on table public.vocabulary_progress to anon;
grant select, insert, update on table public.vocabulary_topic_progress to anon;
grant select, insert, update on table public.grammar_progress to anon;

drop policy if exists "polina homework read" on public.homework_progress;
drop policy if exists "polina homework write" on public.homework_progress;
drop policy if exists "polina homework select" on public.homework_progress;
drop policy if exists "polina homework insert" on public.homework_progress;
drop policy if exists "polina homework update" on public.homework_progress;
create policy "polina homework select" on public.homework_progress
  for select to anon using (student_id = 'polina');
create policy "polina homework insert" on public.homework_progress
  for insert to anon with check (student_id = 'polina');
create policy "polina homework update" on public.homework_progress
  for update to anon using (student_id = 'polina') with check (student_id = 'polina');

drop policy if exists "polina vocab read" on public.vocabulary_progress;
drop policy if exists "polina vocab write" on public.vocabulary_progress;
drop policy if exists "polina vocabulary select" on public.vocabulary_progress;
drop policy if exists "polina vocabulary insert" on public.vocabulary_progress;
drop policy if exists "polina vocabulary update" on public.vocabulary_progress;
create policy "polina vocabulary select" on public.vocabulary_progress
  for select to anon using (student_id = 'polina');
create policy "polina vocabulary insert" on public.vocabulary_progress
  for insert to anon with check (student_id = 'polina');
create policy "polina vocabulary update" on public.vocabulary_progress
  for update to anon using (student_id = 'polina') with check (student_id = 'polina');

drop policy if exists "polina vocab topics read" on public.vocabulary_topic_progress;
drop policy if exists "polina vocab topics write" on public.vocabulary_topic_progress;
drop policy if exists "polina vocabulary topics select" on public.vocabulary_topic_progress;
drop policy if exists "polina vocabulary topics insert" on public.vocabulary_topic_progress;
drop policy if exists "polina vocabulary topics update" on public.vocabulary_topic_progress;
create policy "polina vocabulary topics select" on public.vocabulary_topic_progress
  for select to anon using (student_id = 'polina');
create policy "polina vocabulary topics insert" on public.vocabulary_topic_progress
  for insert to anon with check (student_id = 'polina');
create policy "polina vocabulary topics update" on public.vocabulary_topic_progress
  for update to anon using (student_id = 'polina') with check (student_id = 'polina');

drop policy if exists "polina grammar read" on public.grammar_progress;
drop policy if exists "polina grammar write" on public.grammar_progress;
drop policy if exists "polina grammar select" on public.grammar_progress;
drop policy if exists "polina grammar insert" on public.grammar_progress;
drop policy if exists "polina grammar update" on public.grammar_progress;
create policy "polina grammar select" on public.grammar_progress
  for select to anon using (student_id = 'polina');
create policy "polina grammar insert" on public.grammar_progress
  for insert to anon with check (student_id = 'polina');
create policy "polina grammar update" on public.grammar_progress
  for update to anon using (student_id = 'polina') with check (student_id = 'polina');

commit;

-- Verification queries. They do not change anything.
select student_id, lesson_id, score_correct, score_total, migrated_from_legacy
from public.homework_progress
where student_id = 'polina'
order by lesson_id;

select student_id, topic_id, passed, attempts, best_score
from public.grammar_progress
where student_id = 'polina'
order by topic_id;

select student_id, topic_id, legacy_learned_count, legacy_total, legacy_source
from public.vocabulary_topic_progress
where student_id = 'polina'
order by topic_id;
