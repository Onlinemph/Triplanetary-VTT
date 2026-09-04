-- ---------------------------------------------------------------------------
-- A cost for guessing.
--
-- Join codes are six characters from a 31-letter alphabet, so there are about
-- 887 million of them and a lucky guess lands you a chair at a stranger's
-- table. That is a slow attack and a real one: the refusal is uniform and tells
-- you nothing, but a *hit* announces itself by returning the table, so a loop
-- with one account and a fast connection is a search with a payoff.
--
-- The answer is not a cleverer code. It is to make guessing cost something.
-- Anonymous accounts are cheap — Supabase mints them at thirty an hour per
-- address — but they are not free, and a per-account budget turns "guess until
-- you land" into "mint an account every twenty guesses", which is a different
-- and much less attractive shape.
--
-- Deliberately not a general rate limiter. The only call worth spending a table
-- and a write on is the one with a secret to guess; `command` is already gated
-- by holding a seat, and `create` by the lobby reaper below.
-- ---------------------------------------------------------------------------

create table if not exists public.join_attempts (
  user_id      uuid primary key,
  tries        integer not null default 0 check (tries >= 0),
  window_start timestamptz not null default now()
);

alter table public.join_attempts enable row level security;

-- No policy and no grant: this table is the referee's own bookkeeping, and a
-- client that could read it would learn how close somebody else was to a hit.
revoke all on table public.join_attempts from public, anon, authenticated;
grant all on table public.join_attempts to service_role;

-- How many misses an account may have inside one window before it is turned
-- away, and how long the window is. Twenty is far more than anybody typing a
-- code off a screen will ever need, and far fewer than a search needs.
create or replace function public.note_join_attempt(p_user uuid, p_hit boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tries  integer;
  v_start  timestamptz;
  v_limit  constant integer := 20;
  v_window constant interval := interval '10 minutes';
begin
  -- A hit clears the slate: somebody who found their friend's table is not the
  -- thing this is for, and their next join should not be refused because they
  -- fumbled the code twice first.
  if p_hit then
    delete from public.join_attempts a where a.user_id = p_user;
    return true;
  end if;

  insert into public.join_attempts (user_id, tries, window_start)
       values (p_user, 1, now())
  on conflict (user_id) do update
          set tries = case
                        when public.join_attempts.window_start < now() - v_window then 1
                        else public.join_attempts.tries + 1
                      end,
              window_start = case
                        when public.join_attempts.window_start < now() - v_window then now()
                        else public.join_attempts.window_start
                      end
    returning tries, window_start into v_tries, v_start;

  return v_tries <= v_limit;
end;
$$;

revoke execute on function public.note_join_attempt(uuid, boolean) from public, anon, authenticated;
grant execute on function public.note_join_attempt(uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Reaping
-- ---------------------------------------------------------------------------

-- A lobby nobody came back to is a row that will sit there for ever, and a
-- table that still answers `join` is still a target. Deleting them keeps both
-- the namespace and the guessing surface small. Called by the referee rather
-- than scheduled, so the migration needs no extension: the cost is one indexed
-- sweep on the rare create that trips the interval.
create or replace function public.reap_stale_lobbies(p_age interval default interval '12 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gone integer;
begin
  with dead as (
    delete from public.games g
     where g.status = 'lobby'
       and g.updated_at < now() - p_age
    returning 1
  )
  select count(*) into v_gone from dead;
  return v_gone;
end;
$$;

revoke execute on function public.reap_stale_lobbies(interval) from public, anon, authenticated;
grant execute on function public.reap_stale_lobbies(interval) to service_role;
