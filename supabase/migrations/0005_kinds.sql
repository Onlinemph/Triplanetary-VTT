-- Two games at one table, and a password to remember instead of an account.
--
-- `games.kind` says which engine the referee runs for a table: the fleet game
-- or the ground game. Nothing else in the schema cares — a game is still a
-- starting board plus an ordered log, whichever rules produced it.
--
-- `game_secrets.password` is the table's password, salted and hashed by the
-- referee, or null for a table that opens on its code alone. It lives beside
-- the seed and the board rather than on `games` because seated players may
-- read their own `games` row and must not read this. The password gets a
-- player to the table; a seat is theirs from the device that took it, and
-- `reclaim_seat` lets the password plus a seat name take that seat back from
-- another device — dropping whoever held it, which among friends is the rule.

alter table public.games
  add column if not exists kind text not null default 'tri'
  check (kind in ('tri', 'ogre'));

alter table public.game_secrets
  add column if not exists password text;

-- create_game gains the kind and the password. The old signature goes, so
-- there is one function by this name and no ambiguity about which one an
-- RPC call resolves to.
drop function if exists public.create_game(
  text, text, boolean, uuid, bigint, jsonb, jsonb, jsonb, integer, jsonb
);

create or replace function public.create_game(
  p_code     text,
  p_scenario text,
  p_fog      boolean,
  p_host     uuid,
  p_seed     bigint,
  p_options  jsonb,
  p_fleets   jsonb,
  p_state    jsonb,
  p_turn     integer,
  p_seats    jsonb,
  p_kind     text,
  p_password text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_id         uuid;
  v_constraint text;
begin
  insert into public.games (code, scenario_id, fog, status, turn, host_id, kind)
  values (p_code, p_scenario, p_fog, 'lobby', p_turn, p_host, p_kind)
  returning id into v_id;

  insert into public.game_secrets (game_id, seed, options, fleets, state, password)
  values (v_id, p_seed, p_options, p_fleets, p_state, p_password);

  insert into public.seats (game_id, seat, ordinal, faction, name, kind, user_id, last_seen)
  select v_id, e.seat, e.ordinal, e.faction, e.name, e.kind, e.user_id, e.last_seen
    from jsonb_to_recordset(p_seats)
      as e(seat text, ordinal integer, faction text, name text, kind text,
           user_id uuid, last_seen timestamptz);

  return jsonb_build_object('ok', true, 'id', v_id);
exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'games_code_key' then
      return jsonb_build_object('ok', false, 'reason', 'code-taken');
    end if;
    raise;
end;
$$;

-- Take a seat back with the password: the referee has checked it before
-- calling this. The seat goes to the caller whoever held it, and any other
-- seat the caller held at this table is vacated — one account, one seat.
create or replace function public.reclaim_seat(
  p_game uuid,
  p_user uuid,
  p_seat text,
  p_name text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_kind text;
begin
  perform 1 from public.games g where g.id = p_game for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'gone');
  end if;

  select s.kind into v_kind
    from public.seats s
   where s.game_id = p_game and s.seat = p_seat;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no-seat');
  end if;
  if v_kind = 'computer' then
    return jsonb_build_object('ok', false, 'reason', 'computer');
  end if;

  update public.seats s
     set user_id = null, kind = 'open', last_seen = null
   where s.game_id = p_game
     and s.user_id = p_user
     and s.seat <> p_seat;

  update public.seats s
     set user_id   = p_user,
         kind      = 'human',
         name      = coalesce(nullif(trim(p_name), ''), s.name),
         last_seen = now()
   where s.game_id = p_game
     and s.seat = p_seat;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function
  public.create_game(text, text, boolean, uuid, bigint, jsonb, jsonb, jsonb, integer, jsonb, text, text),
  public.reclaim_seat(uuid, uuid, text, text)
from public, anon, authenticated;

grant execute on function
  public.create_game(text, text, boolean, uuid, bigint, jsonb, jsonb, jsonb, integer, jsonb, text, text),
  public.reclaim_seat(uuid, uuid, text, text)
to service_role;
