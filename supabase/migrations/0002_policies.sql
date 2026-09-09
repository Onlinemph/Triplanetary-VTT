-- ---------------------------------------------------------------------------
-- Who may read what, and nobody may write.
--
-- The threat here is not an outsider. It is a player with a genuine account, a
-- genuine JWT and a genuine seat at one table, holding the same Supabase client
-- library everybody else holds, typing whatever they like into it. PostgREST
-- will happily run their query; the only thing standing between them and the
-- board is this file.
--
-- Three rules generate all of it:
--
--  1. **Membership, not knowledge, grants a read.** Holding a game's id or its
--     join code entitles you to nothing. Only a `seats` row with your account
--     on it does. Codes are short enough to guess, ids leak into logs and URLs,
--     and neither was ever a secret worth defending.
--  2. **Clients read; the referee writes.** There is not one INSERT, UPDATE or
--     DELETE policy in this file. "A client may not insert a command; row level
--     security refuses it. That is what makes `by` mean something." The same
--     reasoning applies to every other table: a seat is taken by calling the
--     function, not by writing the row that records it.
--  3. **Fail closed.** Every helper below returns "no" for a game that does not
--     exist, and the fog helper returns "fogged" when it cannot tell, so a
--     dangling id is treated as the most secret thing it could be.
--
-- Two independent layers do the work, and both are needed. Grants decide which
-- statements the role may attempt at all; policies filter the rows a permitted
-- statement returns. Row level security only filters what a grant already
-- allows, so a table left with Supabase's default grants and no policy is
-- world-readable through PostgREST — which is why the revokes come first.
--
-- `force row level security` is deliberately not set. The owner (`postgres`)
-- bypassing its own policies is what lets a migration or an incident be fixed
-- from the SQL editor, and no client ever connects as the owner. The referee
-- bypasses them too, through `service_role`, which is the entire point of it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Grants: take away Supabase's defaults, hand back only SELECT
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

revoke all on table
  public.games,
  public.game_secrets,
  public.seats,
  public.commands,
  public.views
from public, anon, authenticated;

-- `anon` is given nothing at all. A person who has not signed in has no seat,
-- so every policy below would filter them to nothing anyway; refusing the
-- statement outright is cheaper and says so more plainly.
grant select on table
  public.games,
  public.seats,
  public.commands,
  public.views
to authenticated;

-- Never `game_secrets`. Not to `authenticated`, not to `anon`, not by policy,
-- not ever. The seed and the whole board live in that table.
grant all on table
  public.games,
  public.game_secrets,
  public.seats,
  public.commands,
  public.views
to service_role;

-- ---------------------------------------------------------------------------
-- Membership, asked without recursing
-- ---------------------------------------------------------------------------

-- These are `security definer` for a reason that is easy to miss: a policy on
-- `seats` that queries `seats` re-enters the same policy and PostgreSQL refuses
-- it as infinite recursion. Running the lookup as the owner steps outside row
-- level security to answer the one question row level security needs answered.
--
-- That makes them the most dangerous objects in the schema, so they are kept
-- boring. Each takes a game id the caller already holds and returns a fact
-- about the caller — never about anybody else, never a seed, never a board.
-- `search_path = ''` forces every name to be qualified, so nothing here can be
-- redirected by a caller who creates a `seats` table of their own on a search
-- path we forgot to pin.
--
-- Note what is absent: there is no lookup-by-code function. The join flow does
-- not need one, because `JoinRequest` carries the code to the Edge Function,
-- which holds the service role and does the lookup there. A client-callable
-- code lookup would be a brute-forceable oracle over a six-character alphabet
-- for no gain at all.

create or replace function public.seat_at(p_game uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.seat
    from public.seats s
   where s.game_id = p_game
     and s.user_id is not null
     and s.user_id = (select auth.uid())
   limit 1;
$$;

create or replace function public.is_seated(p_game uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.seats s
     where s.game_id = p_game
       and s.user_id is not null
       and s.user_id = (select auth.uid())
  );
$$;

-- Fog decides whether the command log may be read, so an unknown game is
-- treated as fogged. The coalesce is the fail-closed direction.
create or replace function public.game_is_fogged(p_game uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select g.fog from public.games g where g.id = p_game), true);
$$;

-- `create function` grants EXECUTE to PUBLIC. For a security definer function
-- that default is a standing invitation, so it is withdrawn and handed back by
-- name. `authenticated` needs it because policies are evaluated as the caller.
revoke execute on function
  public.seat_at(uuid),
  public.is_seated(uuid),
  public.game_is_fogged(uuid)
from public, anon;

grant execute on function
  public.seat_at(uuid),
  public.is_seated(uuid),
  public.game_is_fogged(uuid)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.games        enable row level security;
alter table public.game_secrets enable row level security;
alter table public.seats        enable row level security;
alter table public.commands     enable row level security;
alter table public.views        enable row level security;

-- games: the table you are at, and no other. In particular this is what makes
-- the join code worthless on its own — `where code = 'ABC234'` is filtered by
-- membership like every other predicate.
create policy games_read_own_table on public.games
  for select to authenticated
  using (public.is_seated(id));

-- seats: the roster of the table you are at. It carries other players' account
-- ids, which is a real disclosure and an accepted one: an opaque uuid shared
-- with the two people you sat down with. Hiding it would mean column-level
-- grants, and a client without SELECT on every column cannot issue `select *`,
-- which is what Supabase Realtime's own row authorisation appears to do.
-- Breaking the roster stream to hide a uuid from somebody already looking at
-- your ships is the wrong trade.
create policy seats_read_own_table on public.seats
  for select to authenticated
  using (public.is_seated(game_id));

-- commands: readable only where the log is not itself the secret.
--
-- In an open-information game the log is the transport — every seat replays it
-- and lands on the identical board — so every seat at that table may read it.
-- In a fog game the log plus the starting position reconstructs the whole
-- board, undetected ships included, which is precisely what the fog is for. So
-- fog games do not stream commands to anyone; their seats read `views` instead.
create policy commands_read_open_log on public.commands
  for select to authenticated
  using (public.is_seated(game_id) and not public.game_is_fogged(game_id));

-- views: your own snapshot. `seat_at` returns null for a game you are not at,
-- and `seat = null` is null rather than true, so the fail-closed case needs no
-- special handling.
create policy views_read_own_seat on public.views
  for select to authenticated
  using (seat = public.seat_at(game_id));

-- game_secrets: an explicit refusal rather than an empty policy list.
--
-- No policy at all would deny exactly as much, but reads as an oversight to
-- anybody auditing `pg_policies` later, and this is the one table where an
-- oversight is unrecoverable. There are no grants on it either, so a client
-- never gets far enough for this to be evaluated. Both layers say no.
create policy game_secrets_nobody on public.game_secrets
  for all to authenticated, anon
  using (false) with check (false);

-- ---------------------------------------------------------------------------
-- What streams
-- ---------------------------------------------------------------------------

-- A row reaches a subscriber only if two things are true: the publication
-- carries the table, and row level security lets that subscriber SELECT the
-- row. The policies above are therefore also the Realtime rules — a seat is
-- sent its own view row and nobody else's, and in a fog game the command log
-- does not stream at all, because it does not read at all.
--
-- Supabase creates `supabase_realtime` when a project is provisioned. Creating
-- it when missing lets this migration run on a bare PostgreSQL as well, which
-- is how the policies get tested.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

do $$
declare
  t text;
begin
  -- `game_secrets` is absent from this list, and that is the whole list.
  foreach t in array array['games', 'seats', 'commands', 'views'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- Replica identity, stated rather than defaulted into, because the obvious
-- answer is wrong for the one table it matters on.
--
-- Logical decoding always emits the complete NEW tuple for an UPDATE; replica
-- identity governs the OLD one. `views` is rewritten in place and a subscriber
-- needs the new snapshot, which it gets either way — while `full` would put a
-- second copy of a whole redacted board into the WAL on every single command.
-- The primary key is also all the policies read, so `default` is enough for
-- Realtime to authorise the row.
alter table public.views    replica identity default;
alter table public.seats    replica identity default;
alter table public.games    replica identity default;
alter table public.commands replica identity default;
