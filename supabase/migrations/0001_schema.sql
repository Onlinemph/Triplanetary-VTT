-- ---------------------------------------------------------------------------
-- The tables an online game lives in.
--
-- A game is its starting position plus an ordered list of commands. That one
-- sentence decides the whole schema: `game_secrets` holds the position and
-- `commands` holds the list, and everything else here could in principle be
-- recomputed from those two.
--
-- The split between `games` and `game_secrets` is the security boundary, and it
-- is two tables rather than two sets of columns because row level security
-- filters rows, not columns. `games` is the row a player at the table is
-- allowed to hold: the join code, the scenario, whose turn it is.
-- `game_secrets` holds the seed and the authoritative board, and it is given no
-- policy at all, so no client may read it however it asks.
--
-- Two ways to hear what happened, so two tables to hear it on. An
-- open-information game appends to `commands` and every seat replays the log. A
-- fog game gets one row per seat in `views`, rewritten in place, because "a
-- client that could replay the command could also derive the very thing the fog
-- exists to withhold".
--
-- Nothing here trusts the referee either. `commands` is append-only for the
-- service role too, and indexes are checked gapless on the way in. The log is
-- the only record of what happened, and a log that can be rewritten afterwards
-- is not a record of anything.
--
-- Row level security is turned on and the grants are cut in 0002_policies.sql.
-- Until that migration runs these tables are wide open, which is fine for the
-- half-second between them and would not be fine for anything else — the two
-- files are one change and must be applied together.
-- ---------------------------------------------------------------------------

-- Deliberately no foreign key to `auth.users`. An account being deleted must
-- not delete or half-delete a game two other people are still playing; the
-- referee vacates the seat instead, which is the behaviour `leaveSeat` already
-- implements. Keeping the reference out also means every statement in this file
-- is ordinary PostgreSQL, so the schema can be run — and tested — anywhere.

-- ---------------------------------------------------------------------------
-- Bookkeeping shared by several tables
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- games — the public face of a table
-- ---------------------------------------------------------------------------

create table if not exists public.games (
  id             uuid primary key default gen_random_uuid(),

  -- "No `0/O`, no `1/I/L`: a code exists to be typed from somebody else's
  --  screen or repeated down a phone." The constraint is `CODE_ALPHABET` from
  --  referee.ts written out; if that alphabet ever changes, this changes with
  --  it, and a mismatch fails loudly at insert rather than quietly at join.
  code           text not null unique
                 check (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'),

  scenario_id    text not null check (scenario_id <> ''),
  fog            boolean not null default false,
  status         text not null default 'lobby'
                 check (status in ('lobby', 'playing', 'finished')),
  turn           integer not null default 0 check (turn >= 0),

  -- Maintained by the trigger on `commands`, not by whoever is writing. Two
  -- places that both remember how long the log is will eventually disagree.
  command_count  integer not null default 0 check (command_count >= 0),

  host_id        uuid not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger games_touch_updated_at
  before update on public.games
  for each row execute function public.touch_updated_at();

-- Reaping abandoned lobbies is the only query that scans rather than seeks.
create index if not exists games_status_updated_idx
  on public.games (status, updated_at desc);

-- ---------------------------------------------------------------------------
-- game_secrets — the half of a game no client may ever hold
-- ---------------------------------------------------------------------------

-- One row per game, and the reason the schema is shaped this way at all.
-- `state` is the authoritative board with nothing redacted; `seed` is the
-- scenario's setup roll. Either one in a browser ends the game as a game.
create table if not exists public.game_secrets (
  game_id    uuid primary key references public.games (id) on delete cascade,
  seed       bigint not null,
  options    jsonb not null default '{}'::jsonb,
  fleets     jsonb not null default '{}'::jsonb,

  -- The generator inside `state` is always sealed to zero. "The referee draws a
  -- fresh, unguessable seed for every command", so the number resting here
  -- between commands is deliberately meaningless — see `sealDie`. Nothing
  -- enforces that here, because a check constraint reaching into jsonb to
  -- police a rule the referee already applies buys less than it costs.
  state      jsonb not null,
  updated_at timestamptz not null default now()
);

create trigger game_secrets_touch_updated_at
  before update on public.game_secrets
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- seats — who is playing which side
-- ---------------------------------------------------------------------------

create table if not exists public.seats (
  game_id   uuid not null references public.games (id) on delete cascade,
  seat      text not null check (seat <> ''),
  ordinal   integer not null check (ordinal >= 0),
  faction   text not null,
  name      text not null,
  kind      text not null default 'open' check (kind in ('open', 'human', 'computer')),

  -- Null unless a person is sitting here. A computer seat is played by the
  -- referee and is held by nobody, which is what makes the check below an
  -- equivalence rather than an implication.
  user_id   uuid,
  last_seen timestamptz,

  primary key (game_id, seat),
  constraint seats_holder_matches_kind check ((user_id is not null) = (kind = 'human')),
  constraint seats_ordinal_unique unique (game_id, ordinal),

  -- "One account, one seat: taking a new one vacates the old." Deferred because
  -- `takeSeat` writes the vacated seat and the claimed seat as separate rows,
  -- and one order of those two writes would trip an immediate constraint half
  -- way through a move that is legal at the end of it.
  constraint seats_one_per_account unique (game_id, user_id) deferrable initially deferred
);

-- Every policy in 0002 starts by asking "is the caller seated at this game",
-- which is this index.
create index if not exists seats_user_idx
  on public.seats (user_id) where user_id is not null;

-- ---------------------------------------------------------------------------
-- commands — the ordered list that is the game
-- ---------------------------------------------------------------------------

create table if not exists public.commands (
  game_id    uuid not null references public.games (id) on delete cascade,
  idx        integer not null check (idx >= 1),
  by         text not null,
  cmd        jsonb not null,

  -- The seed this command was rolled with. `applyCommand` runs with a 32-bit
  -- generator and the referee normalises with `die >>> 0`, so the range is
  -- exact and worth stating: a value outside it means somebody wrote the log
  -- without going through the referee.
  die        bigint not null check (die >= 0 and die <= 4294967295),
  created_at timestamptz not null default now(),

  primary key (game_id, idx)
);

-- `LoggedCommand.idx` is documented "Gapless, and the game's canonical order",
-- and replay is only exact if that is true. The primary key stops two commands
-- taking the same slot; this stops the log skipping one.
create or replace function public.commands_are_gapless()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  expected integer;
begin
  select coalesce(max(c.idx), 0) + 1 into expected
    from public.commands c where c.game_id = new.game_id;
  if new.idx <> expected then
    raise exception 'command log for game % expects index %, got %',
      new.game_id, expected, new.idx
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger commands_gapless
  before insert on public.commands
  for each row execute function public.commands_are_gapless();

-- Append-only, and note there is no `to authenticated` here: a trigger binds
-- everybody, the service role included. Row level security already stops a
-- player rewriting the log, but the referee holds the service role and bypasses
-- all of it, so without this the one participant with the most to gain from an
-- edited history is the only one able to make one.
--
-- The `exists` is what lets a game still be deleted: `on delete cascade`
-- removes the parent row first, so by the time this fires for the children
-- there is no game left to protect.
create or replace function public.commands_are_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.games g where g.id = old.game_id) then
    raise exception 'the command log is append-only'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

create trigger commands_no_delete
  before delete on public.commands
  for each row execute function public.commands_are_append_only();

create or replace function public.commands_are_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'the command log is append-only'
    using errcode = 'check_violation';
end;
$$;

create trigger commands_no_update
  before update on public.commands
  for each row execute function public.commands_are_immutable();

-- `games.command_count` is the log's length, so let the log say so. The
-- alternative is for every writer to remember, and the first one that forgets
-- leaves a client convinced it is caught up when it is two commands behind.
create or replace function public.commands_bump_count()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.games
     set command_count = new.idx,
         updated_at = now()
   where id = new.game_id;
  return null;
end;
$$;

create trigger commands_count
  after insert on public.commands
  for each row execute function public.commands_bump_count();

-- ---------------------------------------------------------------------------
-- views — one redacted board per seat, for fog games only
-- ---------------------------------------------------------------------------

create table if not exists public.views (
  game_id    uuid not null,
  seat       text not null,

  -- Which log index this snapshot reflects, "so a client can spot a stale row".
  idx        integer not null default 0 check (idx >= 0),
  state      jsonb not null,
  updated_at timestamptz not null default now(),

  primary key (game_id, seat),

  -- A view belongs to a seat, not merely to a game. Keying it to the seat row
  -- means an unseated ghost snapshot cannot exist, and the seat's own cascade
  -- takes the view with it.
  foreign key (game_id, seat) references public.seats (game_id, seat) on delete cascade
);

create trigger views_touch_updated_at
  before update on public.views
  for each row execute function public.touch_updated_at();
