-- Triplanetary — online tables on Supabase, with nothing to deploy.
--
-- Paste this whole file into the Supabase dashboard's SQL Editor and press
-- Run. That is the entire setup: no command line, no Edge Function, no
-- service key. Running it again later is safe — every statement is written to
-- be repeatable.
--
-- ## What this is, and what it is not
--
-- There are two ways to play Triplanetary over the internet, and they are for
-- different tables.
--
-- **This one** is the quick one. The database orders the moves, rolls the
-- dice, and relays each move to whoever is connected; every browser runs the
-- same rules on the same list and lands on the same board. It is the model a
-- group of friends wants: paste one file, share a code and a password, play.
--
-- It carries both games. A table names its `kind` — `tri` for the fleet game,
-- `ogre` for the ground one — and nothing else here changes, because nothing
-- here knows either rulebook: a game is a scenario, a seed and an ordered list
-- of moves whichever engine reads them. A war that hands off to a ground
-- battle opens a second table for it, at a code both browsers work out for
-- themselves from this table's code, so the hand-off needs no referee either.
--
-- **The other** (`supabase/migrations/`, plus an Edge Function) puts a referee
-- on the server. It judges every order against the rules before accepting it,
-- and it can hold a board that no player is allowed to see in full.
--
-- The difference that matters is trust. Here, the rules are enforced by each
-- browser, so a player who edits their own copy can propose a move the rules
-- forbid. The others will notice — every move carries a fingerprint of the
-- board it produced, and a mismatch is reported rather than played through —
-- but noticing is not preventing. Among people who chose to sit down together
-- that is the right trade. Against strangers it is not, and that is what the
-- refereed mode is for.
--
-- ## Fog of war is refused here, on purpose
--
-- Two scenarios — Escape and Lateral 7 — turn on hidden information, and this
-- mode cannot keep it. The move list is the game: anyone holding it can replay
-- it and reconstruct the whole board, hidden ships included. Withholding the
-- secret from the screen would not withhold it from the person reading the
-- feed. So `tri_host` refuses a fogged setup rather than offering a secret it
-- cannot keep. Those two play hot-seat, solo, or on the refereed mode.
--
-- ## Who can read what
--
-- The move feed is readable by anyone, because that is how Supabase Realtime
-- delivers it — a row reaches a subscriber only if a SELECT policy would let
-- them read it, and there is no password to check at subscribe time. Stated
-- plainly: someone who guesses a table code can watch that game. Since fogged
-- setups are refused above, there is nothing in the feed that both players are
-- not already entitled to see, so what is exposed is a game of Triplanetary
-- between strangers.
--
-- Everything else is closed. `tri_tables` holds the password hash and is never
-- read directly by a browser; every way in is a function that checks the
-- password first. Seats are held by a per-browser key, so knowing the password
-- lets you join the table but not play somebody else's ships.
--
-- ## The dice
--
-- Rolled here, by Postgres, and this is the one place this mode does not cut a
-- corner. Triplanetary's generator is a single number carried inside the game
-- state, so a browser holding the state can roll the next die *before*
-- deciding whether to open fire. Letting the client that proposes a move also
-- supply its die would hand every player that. Instead `tri_play` draws from
-- `gen_random_bytes` and stores the result beside the move: unguessable
-- forward, and exact on replay, because the list carries its dice with it.

-- Supabase keeps extensions in their own schema; a plain Postgres puts them in
-- public. Install into whichever exists, and every function below searches
-- both — otherwise crypt() and gen_random_bytes() are simply invisible.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    begin
      execute 'create extension pgcrypto with schema extensions';
    exception when others then
      execute 'create extension pgcrypto';
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists tri_tables (
  code          text primary key,
  name          text        not null default '',
  -- bcrypt, never the password itself, and never readable by a client.
  password_hash text        not null,
  scenario_id   text        not null,
  -- Everything `buildScenario` needs: seed, options, fleets. Frozen at host
  -- time — the board a joiner replays has to be the board the host started.
  setup         jsonb       not null,
  -- seat -> {key, name, at}. The key is the claimant's per-browser secret; a
  -- claim goes stale after five minutes without renewal, so a closed tab gives
  -- its chair back by silence rather than by remembering to leave.
  seats         jsonb       not null default '{}'::jsonb,
  listed        boolean     not null default true,
  turn          integer     not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Which game is on the table. Added after the fact, so an install from before
-- both games were carried keeps every table it already had, as the fleet game.
alter table tri_tables
  add column if not exists kind text not null default 'tri'
  check (kind in ('tri', 'ogre'));

create table if not exists tri_moves (
  code       text        not null references tri_tables(code) on delete cascade,
  idx        integer     not null,
  seat       text        not null,
  cmd        jsonb       not null,
  -- The generator seed this move was applied with, drawn by `tri_play`.
  die        bigint      not null,
  -- A fingerprint of the board the sender ended up with. A client that applies
  -- the move and computes something else knows its copy has drifted.
  hash       text,
  created_at timestamptz not null default now(),
  primary key (code, idx)
);

create index if not exists tri_moves_code_idx on tri_moves (code, idx);
create index if not exists tri_tables_updated on tri_tables (updated_at);
create index if not exists tri_tables_listed on tri_tables (listed, updated_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table tri_tables enable row level security;
alter table tri_moves enable row level security;

-- No policy on tri_tables at all: with RLS on and nothing granting a read, a
-- client cannot reach the password hash, the seat keys, or the setup of a
-- table it has not opened through a function.
drop policy if exists tri_moves_readable on tri_moves;
create policy tri_moves_readable on tri_moves for select using (true);

-- Deletes carry the old row to subscribers, so an undo can be recognised.
alter table tri_moves replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and tablename = 'tri_moves'
     )
  then
    alter publication supabase_realtime add table tri_moves;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- A fresh 32-bit generator seed, from the cryptographic source rather than
-- from `random()`. `get_byte` rather than a bit-string cast because the cast
-- lands on a signed integer and the engine wants [0, 2^32).
create or replace function tri_roll()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  b bytea := gen_random_bytes(4);
begin
  return (get_byte(b, 0)::bigint * 16777216)
       + (get_byte(b, 1)::bigint * 65536)
       + (get_byte(b, 2)::bigint * 256)
       +  get_byte(b, 3)::bigint;
end;
$$;

-- ---------------------------------------------------------------------------
-- The functions the game calls
-- ---------------------------------------------------------------------------
-- All SECURITY DEFINER: they run with the owner's rights and so reach past row
-- level security — and each checks the table password before doing anything.
-- That check is the whole model: know the code and the password, join the game.

-- The signature gained two arguments, so the old one goes first: leaving it
-- would make two functions of this name and PostgREST could not tell a call
-- for one from a call for the other.
drop function if exists tri_host(text, text, jsonb, text, boolean);

create or replace function tri_host(
  p_password text,
  p_scenario text,
  p_setup    jsonb,
  p_name     text default '',
  p_listed   boolean default true,
  p_kind     text default 'tri',
  p_code     text default null
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code text;
begin
  if coalesce(p_password, '') = '' then
    raise exception 'A table needs a password.';
  end if;

  -- The one setup this mode must not accept. See the header: the move list
  -- reconstructs the board, so a secret in it is not a secret.
  if coalesce((p_setup -> 'options' ->> 'fogOfWar')::boolean, false) then
    raise exception
      'Fog of war needs the refereed mode — this one relays moves, and the move list gives the hidden board away. Play this scenario hot-seat, solo, or on a refereed table.';
  end if;

  if coalesce(p_kind, 'tri') not in ('tri', 'ogre') then
    raise exception 'There is no game by that name.';
  end if;

  -- A caller may name the code it wants. That is how a war opens the table for
  -- its ground battle without a referee to mint one: every browser at the war
  -- works out the same code, the first to arrive opens it, and the rest are
  -- told it is taken and go and join it.
  if coalesce(p_code, '') <> '' then
    v_code := upper(trim(p_code));
    if exists (select 1 from tri_tables t where t.code = v_code) then
      raise exception 'code-taken';
    end if;
  else
    for _ in 1 .. 12 loop
      -- Crockford-ish: no I, O, U or numbers that read as letters, because this
      -- gets read aloud and typed in by somebody else.
      v_code := (
        select string_agg(substr('ABCDEFGHJKMNPQRSTVWXYZ23456789', 1 + (get_byte(b, i) % 30), 1), '')
          from (select gen_random_bytes(6) as b) s, generate_series(0, 5) as i
      );
      exit when not exists (select 1 from tri_tables t where t.code = v_code);
      v_code := null;
    end loop;

    if v_code is null then
      raise exception 'Could not find a free table code. Try again.';
    end if;
  end if;

  insert into tri_tables (code, name, password_hash, scenario_id, setup, listed, kind)
  values (v_code, coalesce(p_name, ''), crypt(p_password, gen_salt('bf')),
          p_scenario, p_setup, coalesce(p_listed, true), coalesce(p_kind, 'tri'));

  return v_code;
end;
$$;

-- Check a password and hand back the table. The shape every other call reuses.
create or replace function tri_open(p_code text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  t tri_tables%rowtype;
begin
  select * into t from tri_tables where code = upper(trim(p_code));
  if not found then
    raise exception 'No table with that code.';
  end if;
  if t.password_hash <> crypt(p_password, t.password_hash) then
    raise exception 'That password does not open this table.';
  end if;

  return jsonb_build_object(
    'code', t.code,
    'name', t.name,
    'scenarioId', t.scenario_id,
    'kind', t.kind,
    'setup', t.setup,
    'seats', (
      -- The keys are secrets. Names and claim times are not.
      select coalesce(jsonb_object_agg(k, jsonb_build_object('name', v ->> 'name', 'at', v ->> 'at')), '{}'::jsonb)
        from jsonb_each(t.seats) as e(k, v)
    ),
    'turn', t.turn,
    'moves', coalesce((
      select jsonb_agg(jsonb_build_object('idx', m.idx, 'seat', m.seat, 'cmd', m.cmd, 'die', m.die, 'hash', m.hash)
             order by m.idx)
        from tri_moves m where m.code = t.code
    ), '[]'::jsonb)
  );
end;
$$;

-- Everything after a given index, for catching up without refetching a game.
create or replace function tri_since(p_code text, p_password text, p_since integer)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  t tri_tables%rowtype;
begin
  select * into t from tri_tables where code = upper(trim(p_code));
  if not found then
    raise exception 'No table with that code.';
  end if;
  if t.password_hash <> crypt(p_password, t.password_hash) then
    raise exception 'That password does not open this table.';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('idx', m.idx, 'seat', m.seat, 'cmd', m.cmd, 'die', m.die, 'hash', m.hash)
           order by m.idx)
      from tri_moves m where m.code = t.code and m.idx > coalesce(p_since, 0)
  ), '[]'::jsonb);
end;
$$;

-- Take a seat, or renew a claim on one already held. Five minutes of silence
-- releases it.
create or replace function tri_sit(
  p_code     text,
  p_password text,
  p_seat     text,
  p_key      text,
  p_name     text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  t     tri_tables%rowtype;
  held  jsonb;
  at    timestamptz;
begin
  select * into t from tri_tables where code = upper(trim(p_code)) for update;
  if not found then
    raise exception 'No table with that code.';
  end if;
  if t.password_hash <> crypt(p_password, t.password_hash) then
    raise exception 'That password does not open this table.';
  end if;
  if coalesce(p_key, '') = '' then
    raise exception 'A seat needs a key.';
  end if;

  held := t.seats -> p_seat;
  if held is not null and held ->> 'key' <> p_key then
    at := (held ->> 'at')::timestamptz;
    -- Somebody else holds it, and recently enough to still be sitting there.
    if at is not null and at > now() - interval '5 minutes' then
      raise exception 'Somebody else is playing that side.';
    end if;
  end if;

  -- One browser, one seat: claiming a new one gives up the old.
  update tri_tables
     set seats = (
           select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
             from jsonb_each(seats) as e(k, v)
            where v ->> 'key' <> p_key
         ) || jsonb_build_object(
           p_seat, jsonb_build_object('key', p_key, 'name', coalesce(p_name, ''), 'at', now())
         ),
         updated_at = now()
   where code = t.code;

  return jsonb_build_object('seat', p_seat);
end;
$$;

-- Give up a seat so somebody else may take it.
create or replace function tri_stand(p_code text, p_password text, p_key text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  t tri_tables%rowtype;
begin
  select * into t from tri_tables where code = upper(trim(p_code)) for update;
  if not found then
    raise exception 'No table with that code.';
  end if;
  if t.password_hash <> crypt(p_password, t.password_hash) then
    raise exception 'That password does not open this table.';
  end if;

  update tri_tables
     set seats = (
           select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
             from jsonb_each(seats) as e(k, v)
            where v ->> 'key' <> p_key
         ),
         updated_at = now()
   where code = t.code;
end;
$$;

-- Give an order.
--
-- `p_after` is the index the caller believes is last, which is what keeps two
-- players pressing at once from interleaving into a board neither expected:
-- the second one is refused and re-reads instead. The die is drawn here, never
-- accepted from the caller.
create or replace function tri_play(
  p_code     text,
  p_password text,
  p_seat     text,
  p_key      text,
  p_cmd      jsonb,
  p_after    integer,
  p_hash     text default null,
  p_turn     integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  t    tri_tables%rowtype;
  held jsonb;
  last integer;
  die  bigint;
begin
  select * into t from tri_tables where code = upper(trim(p_code)) for update;
  if not found then
    raise exception 'No table with that code.';
  end if;
  if t.password_hash <> crypt(p_password, t.password_hash) then
    raise exception 'That password does not open this table.';
  end if;

  -- The seat has to be yours. Knowing the password gets you to the table, not
  -- into somebody else's chair.
  held := t.seats -> p_seat;
  if held is null or held ->> 'key' <> coalesce(p_key, '') then
    raise exception 'That is not your side to move.';
  end if;

  -- And the order has to be signed by the seat giving it, which is the one
  -- check a plain relay cannot make.
  if p_cmd ? 'by' and p_cmd ->> 'by' <> p_seat then
    raise exception 'That order is signed by another side.';
  end if;

  select coalesce(max(m.idx), 0) into last from tri_moves m where m.code = t.code;
  if coalesce(p_after, last) <> last then
    return jsonb_build_object('ok', false, 'reason', 'behind', 'index', last);
  end if;

  die := tri_roll();
  insert into tri_moves (code, idx, seat, cmd, die, hash)
  values (t.code, last + 1, p_seat, p_cmd, die, p_hash);

  update tri_tables
     set turn = coalesce(p_turn, turn),
         seats = jsonb_set(seats, array[p_seat, 'at'], to_jsonb(now())),
         updated_at = now()
   where code = t.code;

  return jsonb_build_object('ok', true, 'index', last + 1, 'die', die);
end;
$$;

-- Take the last move back. Whoever made it, or the host by knowing the
-- password — this mode is a friendly table and undo is part of playing.
create or replace function tri_undo(p_code text, p_password text, p_from integer)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  t tri_tables%rowtype;
begin
  select * into t from tri_tables where code = upper(trim(p_code)) for update;
  if not found then
    raise exception 'No table with that code.';
  end if;
  if t.password_hash <> crypt(p_password, t.password_hash) then
    raise exception 'That password does not open this table.';
  end if;

  delete from tri_moves m where m.code = t.code and m.idx >= p_from;
  update tri_tables set updated_at = now() where code = t.code;
  return (select coalesce(max(m.idx), 0) from tri_moves m where m.code = t.code);
end;
$$;

-- The table browser. Codes only — no password hashes, no setups, no seat keys.
create or replace function tri_list(p_limit integer default 40)
returns jsonb
language sql
security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(row), '[]'::jsonb) from (
    select jsonb_build_object(
             'code', t.code,
             'name', t.name,
             'scenarioId', t.scenario_id,
             'kind', t.kind,
             'turn', t.turn,
             'seats', (select count(*) from jsonb_each(t.seats)),
             'updatedAt', t.updated_at
           ) as row
      from tri_tables t
     where t.listed
     order by t.updated_at desc
     limit least(greatest(coalesce(p_limit, 40), 1), 100)
  ) s;
$$;

-- Housekeeping. Run it whenever, or from pg_cron if you turn that on.
create or replace function tri_sweep(p_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  gone integer;
begin
  with dead as (
    delete from tri_tables where updated_at < now() - make_interval(days => p_days)
    returning 1
  )
  select count(*) into gone from dead;
  return gone;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- The functions are the entire API. Nothing else is reachable: no table read,
-- no insert, no update.

revoke all on tri_tables from anon, authenticated;
revoke all on tri_moves from anon, authenticated;
grant select on tri_moves to anon, authenticated;

revoke execute on function tri_roll() from public, anon, authenticated;

grant execute on function tri_host(text, text, jsonb, text, boolean, text, text) to anon, authenticated;
grant execute on function tri_open(text, text)                       to anon, authenticated;
grant execute on function tri_since(text, text, integer)             to anon, authenticated;
grant execute on function tri_sit(text, text, text, text, text)      to anon, authenticated;
grant execute on function tri_stand(text, text, text)                to anon, authenticated;
grant execute on function tri_play(text, text, text, text, jsonb, integer, text, integer) to anon, authenticated;
grant execute on function tri_undo(text, text, integer)              to anon, authenticated;
grant execute on function tri_list(integer)                          to anon, authenticated;
grant execute on function tri_sweep(integer)                         to anon, authenticated;
